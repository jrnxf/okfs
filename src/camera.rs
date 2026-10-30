//! The preview a camera RAW file carries inside it.
//!
//! A RAW file holds a full-size JPEG next to the sensor data, so the file can be shown without
//! decoding the sensor data. This finds where that JPEG sits, and reads nothing but the headers and
//! the JPEG. It writes no pixels of its own: a file with no preview stays a file with no picture.
//!
//! - CR2, NEF, ARW, DNG, ORF, RW2 and PEF are TIFF containers. Their folders (IFD0, the ones it
//!   chains to and the SubIFDs) name JPEGs by `JPEGInterchangeFormat`, or by `StripOffsets` with a
//!   JPEG `Compression`. RW2 keeps one in a tag of its own.
//! - ORF keeps its preview in the Olympus maker note, which sits in the Exif folder.
//! - CR3 is an ISO base media file, with the JPEG in a `PRVW` box.
//! - RAF has the offset and size of its JPEG in the header.

use std::collections::HashSet;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use image::metadata::Orientation;

/// The extensions of the files this reads, lower case.
pub const EXTENSIONS: [&str; 9] = ["cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raf", "pef"];

/// The most folders of a TIFF container that are read, and how deep the SubIFDs go.
const MAX_IFDS: usize = 32;
const MAX_DEPTH: usize = 3;
/// The most values read from one tag. A folder of strips is longer than any preview needs.
const MAX_VALUES: u32 = 4096;
/// How far into a CR3 `uuid` box the `PRVW` box is looked for.
const PRVW_WINDOW: u64 = 64;

const TAG_COMPRESSION: u16 = 0x103;
const TAG_ORIENTATION: u16 = 0x112;
const TAG_STRIP_OFFSETS: u16 = 0x111;
const TAG_STRIP_BYTES: u16 = 0x117;
const TAG_SUB_IFDS: u16 = 0x14a;
const TAG_JPEG_OFFSET: u16 = 0x201;
const TAG_JPEG_BYTES: u16 = 0x202;
/// Panasonic's own tag for the full-size JPEG of an RW2.
const TAG_RW2_JPEG: u16 = 0x2e;
const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_MAKER_NOTE: u16 = 0x927c;
/// Inside an Olympus maker note: the folder of camera settings, and in it where the preview is.
const TAG_OLYMPUS_SETTINGS: u16 = 0x2020;
const TAG_OLYMPUS_PREVIEW_START: u16 = 0x101;
const TAG_OLYMPUS_PREVIEW_BYTES: u16 = 0x102;
/// The start of a maker note this reads. Its folders count their offsets from its first byte.
const OLYMPUS: &[u8] = b"OLYMPUS\0II";
/// Where the folder of an Olympus maker note begins, after its header.
const OLYMPUS_HEADER: u64 = 12;

/// A byte range of the file that should hold a JPEG.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub offset: u64,
    pub len: u64,
}

/// Where the previews of one file are, largest first, and how the camera was held.
#[derive(Debug, Default)]
pub struct Layout {
    pub spans: Vec<Span>,
    /// The orientation named by the container, for a preview that carries none of its own.
    pub orientation: Option<Orientation>,
}

/// True when the name is a camera RAW file.
pub fn is_camera(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| EXTENSIONS.iter().any(|known| ext.eq_ignore_ascii_case(known)))
}

/// Finds the previews in a file of `size` bytes. An error means the file is not one of the formats.
pub fn layout<R: Read + Seek>(file: &mut R, size: u64) -> io::Result<Layout> {
    let mut head = [0u8; 16];
    file.seek(SeekFrom::Start(0))?;
    let got = read_up_to(file, &mut head)?;
    let head = &head[..got];
    let mut found = if head.starts_with(b"FUJIFILMCCD-RAW ") {
        fuji(file)?
    } else if head.len() >= 12 && &head[4..8] == b"ftyp" {
        isobmff(file, size)?
    } else if head.starts_with(b"II") || head.starts_with(b"MM") {
        tiff(file, size)?
    } else {
        return Err(invalid("not a camera RAW file"));
    };
    found.spans.retain(|span| span.len >= 4 && span.offset.checked_add(span.len).is_some_and(|end| end <= size));
    found.spans.sort_by_key(|span| std::cmp::Reverse(span.len));
    found.spans.dedup();
    Ok(found)
}

/// Reads the bytes of one span. Anything that does not start like a JPEG is refused.
pub fn read_span<R: Read + Seek>(file: &mut R, span: Span) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(span.offset))?;
    let mut bytes = vec![0u8; usize::try_from(span.len).map_err(|_| invalid("preview too large"))?];
    file.read_exact(&mut bytes)?;
    if bytes.starts_with(&[0xff, 0xd8]) {
        Ok(bytes)
    } else {
        Err(invalid("not a JPEG"))
    }
}

/// The size of the JPEG at `span`, read from its first marker that names one. Only the kinds a browser
/// shows are taken: baseline and progressive. The lossless JPEG a RAW file keeps its sensor data in is
/// refused here, so that tens of megabytes of it are never read to find that out.
pub fn probe<R: Read + Seek>(file: &mut R, span: Span) -> io::Result<(u32, u32)> {
    let end = span.offset + span.len;
    let mut at = span.offset;
    let soi: [u8; 2] = read_at(file, at)?;
    if soi != [0xff, 0xd8] {
        return Err(invalid("not a JPEG"));
    }
    at += 2;
    for _ in 0..64 {
        if at + 4 > end {
            break;
        }
        let head: [u8; 4] = read_at(file, at)?;
        if head[0] != 0xff {
            break;
        }
        let marker = head[1];
        let len = u64::from(u16::from_be_bytes([head[2], head[3]]));
        match marker {
            // A fill byte before a marker.
            0xff => at += 1,
            // Start of frame: baseline, extended sequential, progressive.
            0xc0..=0xc2 => {
                let frame: [u8; 9] = read_at(file, at + 4)?;
                let height = u32::from(u16::from_be_bytes([frame[1], frame[2]]));
                let width = u32::from(u16::from_be_bytes([frame[3], frame[4]]));
                return Ok((width, height));
            }
            // Lossless, differential and arithmetic frames, which are not shown.
            0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf => return Err(invalid("a kind of JPEG that is not shown")),
            // The data of the picture begins: no frame came before it.
            0xda | 0xd9 => break,
            _ if len < 2 => break,
            _ => at += 2 + len,
        }
    }
    Err(invalid("no frame in this JPEG"))
}

/// The spans of `layout` worth reading, in the order to try them. Spans that are not JPEGs a browser
/// shows are dropped. For a picture `want` is `None` and the largest comes first. For a thumbnail `want`
/// is its width: the smallest preview that is at least as wide on its short side comes first, as it
/// costs the least to decode, then the larger ones, then the rest.
pub fn choose<R: Read + Seek>(file: &mut R, layout: &Layout, want: Option<u32>) -> Vec<Span> {
    let mut sized: Vec<(Span, u64, u32)> = layout
        .spans
        .iter()
        .filter_map(|span| {
            let (width, height) = probe(file, *span).ok()?;
            Some((*span, u64::from(width) * u64::from(height), width.min(height)))
        })
        .collect();
    sized.sort_by_key(|(_, area, _)| std::cmp::Reverse(*area));
    if let Some(want) = want {
        let (mut enough, short): (Vec<_>, Vec<_>) = sized.into_iter().partition(|(_, _, side)| *side >= want);
        enough.reverse();
        sized = enough.into_iter().chain(short).collect();
    }
    sized.into_iter().map(|(span, _, _)| span).collect()
}

fn invalid(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, why)
}

fn read_up_to<R: Read>(file: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match file.read(&mut buf[got..])? {
            0 => break,
            n => got += n,
        }
    }
    Ok(got)
}

fn read_at<R: Read + Seek, const N: usize>(file: &mut R, at: u64) -> io::Result<[u8; N]> {
    file.seek(SeekFrom::Start(at))?;
    let mut buf = [0u8; N];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

// RAF: the offset and length of the JPEG are big-endian numbers at 0x54 and 0x58.
fn fuji<R: Read + Seek>(file: &mut R) -> io::Result<Layout> {
    let raw: [u8; 8] = read_at(file, 0x54)?;
    let offset = u64::from(u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]));
    let len = u64::from(u32::from_be_bytes([raw[4], raw[5], raw[6], raw[7]]));
    Ok(Layout {
        spans: vec![Span { offset, len }],
        orientation: None,
    })
}

// CR3: boxes of a 4-byte size and a 4-byte type. The `PRVW` box sits in a `uuid` box at the top level.
fn isobmff<R: Read + Seek>(file: &mut R, size: u64) -> io::Result<Layout> {
    let mut spans = Vec::new();
    let mut at: u64 = 0;
    for _ in 0..64 {
        if at.checked_add(8).is_none_or(|end| end > size) {
            break;
        }
        let head: [u8; 8] = read_at(file, at)?;
        let mut len = u64::from(u32::from_be_bytes([head[0], head[1], head[2], head[3]]));
        let mut header = 8;
        if len == 1 {
            let big: [u8; 8] = read_at(file, at + 8)?;
            len = u64::from_be_bytes(big);
            header = 16;
        } else if len == 0 {
            len = size - at;
        }
        if len < header {
            break;
        }
        let Some(end) = at.checked_add(len) else { break };
        if &head[4..8] == b"uuid" {
            spans.extend(preview_box(file, at + header + 16, end.min(size))?);
        }
        at = end;
    }
    Ok(Layout {
        spans,
        orientation: None,
    })
}

/// Looks for `PRVW` soon after the start of a `uuid` box's contents: its box carries 4 reserved
/// bytes, 2 more, the width and the height, 2 more, then the JPEG's length and the JPEG.
fn preview_box<R: Read + Seek>(file: &mut R, from: u64, end: u64) -> io::Result<Option<Span>> {
    if from >= end {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(from))?;
    let mut window = Vec::new();
    file.take(PRVW_WINDOW.min(end - from)).read_to_end(&mut window)?;
    let Some(tag) = window.windows(4).position(|w| w == b"PRVW") else {
        return Ok(None);
    };
    let at = from + tag as u64 + 4;
    let raw: [u8; 16] = read_at(file, at)?;
    let len = u64::from(u32::from_be_bytes([raw[12], raw[13], raw[14], raw[15]]));
    Ok(Some(Span {
        offset: at + 16,
        len,
    }))
}

#[derive(Clone, Copy)]
struct Order {
    big: bool,
}

impl Order {
    fn u16(self, b: [u8; 2]) -> u16 {
        if self.big { u16::from_be_bytes(b) } else { u16::from_le_bytes(b) }
    }

    fn u32(self, b: [u8; 4]) -> u32 {
        if self.big { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) }
    }
}

struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    /// Where the 4 bytes of the value, or of the offset to it, sit.
    slot: u64,
}

struct Walk<'a, R> {
    file: &'a mut R,
    order: Order,
    size: u64,
    seen: HashSet<u64>,
    spans: Vec<Span>,
}

fn tiff<R: Read + Seek>(file: &mut R, size: u64) -> io::Result<Layout> {
    // Besides "II" or "MM" there is a magic number, which is 42 except for some Olympus and Panasonic files.
    let head: [u8; 8] = read_at(file, 0)?;
    let order = Order {
        big: match &head[..2] {
            b"II" => false,
            b"MM" => true,
            _ => return Err(invalid("not a TIFF container")),
        },
    };
    let first = u64::from(order.u32([head[4], head[5], head[6], head[7]]));
    let mut walk = Walk {
        file,
        order,
        size,
        seen: HashSet::new(),
        spans: Vec::new(),
    };
    let orientation = walk.chain(first, 0, true)?;
    Ok(Layout {
        spans: walk.spans,
        orientation,
    })
}

impl<R: Read + Seek> Walk<'_, R> {
    /// Reads the folder at `at`, then the ones it chains to. Returns the orientation of the first folder
    /// when `top`, which is the one that names the picture the camera took.
    fn chain(&mut self, mut at: u64, depth: usize, top: bool) -> io::Result<Option<Orientation>> {
        let mut orientation = None;
        let mut first = true;
        while at != 0 && at + 2 <= self.size && self.seen.len() < MAX_IFDS && self.seen.insert(at) {
            let (found, next) = self.folder(at, depth)?;
            if top && first {
                orientation = found;
            }
            first = false;
            at = next;
        }
        Ok(orientation)
    }

    /// The entries of the folder at `at`, and the offset of the next folder.
    fn entries(&mut self, at: u64) -> io::Result<(Vec<Entry>, u64)> {
        let raw: [u8; 2] = read_at(self.file, at)?;
        let count = u64::from(self.order.u16(raw));
        if at + 2 + count * 12 + 4 > self.size {
            return Err(invalid("folder runs past the file"));
        }
        let mut entries = Vec::with_capacity(count as usize);
        for index in 0..count {
            let base = at + 2 + index * 12;
            let raw: [u8; 8] = read_at(self.file, base)?;
            entries.push(Entry {
                tag: self.order.u16([raw[0], raw[1]]),
                kind: self.order.u16([raw[2], raw[3]]),
                count: self.order.u32([raw[4], raw[5], raw[6], raw[7]]),
                slot: base + 8,
            });
        }
        let next: [u8; 4] = read_at(self.file, at + 2 + count * 12)?;
        Ok((entries, u64::from(self.order.u32(next))))
    }

    /// One folder. Returns its orientation and the offset of the next folder.
    fn folder(&mut self, at: u64, depth: usize) -> io::Result<(Option<Orientation>, u64)> {
        let (entries, next) = self.entries(at)?;

        let find = |tag: u16| entries.iter().find(|entry| entry.tag == tag);
        let mut orientation = None;
        if let Some(entry) = find(TAG_ORIENTATION) {
            let value = self.values(entry)?.first().copied();
            orientation = value.and_then(|v| u8::try_from(v).ok()).and_then(Orientation::from_exif);
        }
        if let (Some(offset), Some(len)) = (find(TAG_JPEG_OFFSET), find(TAG_JPEG_BYTES))
            && let (Some(offset), Some(len)) = (self.values(offset)?.first().copied(), self.values(len)?.first().copied())
        {
            self.spans.push(Span { offset, len });
        }
        // Compression 6 is the old JPEG, and 7 is JPEG. Sensor data is stored as 7 as well, in a form
        // that is not decoded: reading it as a picture fails and the next span is tried.
        let jpeg = match find(TAG_COMPRESSION) {
            Some(entry) => matches!(self.values(entry)?.first(), Some(6 | 7)),
            None => false,
        };
        if let (true, Some(offsets), Some(lens)) = (jpeg, find(TAG_STRIP_OFFSETS), find(TAG_STRIP_BYTES)) {
            let (offsets, lens) = (self.values(offsets)?, self.values(lens)?);
            if let ([offset], [len]) = (offsets.as_slice(), lens.as_slice()) {
                self.spans.push(Span { offset: *offset, len: *len });
            }
        }
        if let Some(entry) = find(TAG_RW2_JPEG) {
            // Undefined bytes: the count is the length, and the value is where they are.
            let offset = self.order.u32(read_at(self.file, entry.slot)?);
            self.spans.push(Span {
                offset: u64::from(offset),
                len: u64::from(entry.count),
            });
        }
        if depth < MAX_DEPTH
            && let Some(entry) = find(TAG_SUB_IFDS)
        {
            for sub in self.values(entry)? {
                self.chain(sub, depth + 1, false)?;
            }
        }
        // A file that is damaged past the maker note still has the previews found so far.
        if let Some(entry) = find(TAG_EXIF_IFD)
            && let Some(&exif) = self.values(entry)?.first()
        {
            let _ = self.exif(exif);
        }
        Ok((orientation, next))
    }

    /// The Exif folder, which holds the maker note.
    fn exif(&mut self, at: u64) -> io::Result<()> {
        let (entries, _) = self.entries(at)?;
        if let Some(note) = entries.iter().find(|entry| entry.tag == TAG_MAKER_NOTE) {
            let offset = u64::from(self.order.u32(read_at(self.file, note.slot)?));
            // An Olympus maker note is always little-endian, whatever the file is.
            let saved = std::mem::replace(&mut self.order, Order { big: false });
            let found = self.olympus(offset);
            self.order = saved;
            found?;
        }
        Ok(())
    }

    /// The maker note at `note`: its camera settings say where the full-size preview is.
    fn olympus(&mut self, note: u64) -> io::Result<()> {
        let head: [u8; 10] = read_at(self.file, note)?;
        if head != *OLYMPUS {
            return Ok(());
        }
        let (entries, _) = self.entries(note + OLYMPUS_HEADER)?;
        let Some(settings) = entries.iter().find(|entry| entry.tag == TAG_OLYMPUS_SETTINGS) else {
            return Ok(());
        };
        let Some(&relative) = self.values(settings)?.first() else {
            return Ok(());
        };
        let (entries, _) = self.entries(note + relative)?;
        let find = |tag: u16| entries.iter().find(|entry| entry.tag == tag);
        if let (Some(start), Some(len)) = (find(TAG_OLYMPUS_PREVIEW_START), find(TAG_OLYMPUS_PREVIEW_BYTES))
            && let (Some(&start), Some(&len)) = (self.values(start)?.first(), self.values(len)?.first())
        {
            self.spans.push(Span {
                offset: note + start,
                len,
            });
        }
        Ok(())
    }

    /// The values of a SHORT or LONG tag. Any other type has none.
    fn values(&mut self, entry: &Entry) -> io::Result<Vec<u64>> {
        let width: u64 = match entry.kind {
            3 => 2,
            4 | 13 => 4,
            _ => return Ok(Vec::new()),
        };
        let count = entry.count.min(MAX_VALUES);
        let total = width * u64::from(count);
        let at = if total <= 4 {
            entry.slot
        } else {
            u64::from(self.order.u32(read_at(self.file, entry.slot)?))
        };
        if at.checked_add(total).is_none_or(|end| end > self.size) {
            return Err(invalid("value runs past the file"));
        }
        self.file.seek(SeekFrom::Start(at))?;
        let mut raw = vec![0u8; total as usize];
        self.file.read_exact(&mut raw)?;
        Ok(raw
            .chunks_exact(width as usize)
            .map(|chunk| match width {
                2 => u64::from(self.order.u16([chunk[0], chunk[1]])),
                _ => u64::from(self.order.u32([chunk[0], chunk[1], chunk[2], chunk[3]])),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn jpeg() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::new_rgb8(8, 4)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Jpeg)
            .unwrap();
        bytes
    }

    /// A little-endian TIFF with a thumbnail in IFD1 and a larger JPEG in a SubIFD of IFD0.
    fn tiff_with_previews(small: &[u8], large: &[u8]) -> Vec<u8> {
        let mut out = vec![b'I', b'I', 42, 0, 8, 0, 0, 0];
        // IFD0 at 8: orientation (6) and SubIFDs; next is IFD1.
        let ifd0 = 8usize;
        let ifd1 = ifd0 + 2 + 2 * 12 + 4;
        let sub = ifd1 + 2 + 2 * 12 + 4;
        let data = sub + 2 + 2 * 12 + 4;
        let entry = |tag: u16, kind: u16, count: u32, value: u32| {
            let mut e = Vec::new();
            e.extend(tag.to_le_bytes());
            e.extend(kind.to_le_bytes());
            e.extend(count.to_le_bytes());
            e.extend(value.to_le_bytes());
            e
        };
        out.extend(2u16.to_le_bytes());
        out.extend(entry(TAG_ORIENTATION, 3, 1, 6));
        out.extend(entry(TAG_SUB_IFDS, 4, 1, sub as u32));
        out.extend((ifd1 as u32).to_le_bytes());
        out.extend(2u16.to_le_bytes());
        out.extend(entry(TAG_JPEG_OFFSET, 4, 1, data as u32));
        out.extend(entry(TAG_JPEG_BYTES, 4, 1, small.len() as u32));
        out.extend(0u32.to_le_bytes());
        out.extend(2u16.to_le_bytes());
        out.extend(entry(TAG_JPEG_OFFSET, 4, 1, (data + small.len()) as u32));
        out.extend(entry(TAG_JPEG_BYTES, 4, 1, large.len() as u32));
        out.extend(0u32.to_le_bytes());
        assert_eq!(out.len(), data);
        out.extend(small);
        out.extend(large);
        out
    }

    #[test]
    fn a_tiff_container_names_its_largest_preview_first() {
        let small = jpeg();
        let mut large = jpeg();
        large.extend([0u8; 32]);
        let file = tiff_with_previews(&small, &large);
        let found = layout(&mut Cursor::new(&file), file.len() as u64).unwrap();
        assert_eq!(found.spans.len(), 2);
        assert_eq!(found.spans[0].len, large.len() as u64);
        assert_eq!(found.orientation, Orientation::from_exif(6));
        let bytes = read_span(&mut Cursor::new(&file), found.spans[0]).unwrap();
        assert_eq!(bytes, large);
    }

    #[test]
    fn a_file_that_is_not_a_container_or_runs_short_is_refused() {
        assert!(layout(&mut Cursor::new(b"hello world, not a photo".to_vec()), 24).is_err());
        let file = tiff_with_previews(&jpeg(), &jpeg());
        let cut = &file[..file.len() - 20];
        let found = layout(&mut Cursor::new(cut), cut.len() as u64).unwrap();
        assert!(found.spans.len() < 2);
        // A loop of folders ends.
        let mut looped = vec![b'I', b'I', 42, 0, 8, 0, 0, 0, 0, 0];
        looped.extend(8u32.to_le_bytes());
        assert!(layout(&mut Cursor::new(&looped), looped.len() as u64).unwrap().spans.is_empty());
    }

    #[test]
    fn a_fuji_header_and_a_canon_box_name_their_jpeg() {
        let pic = jpeg();
        let mut raf = b"FUJIFILMCCD-RAW ".to_vec();
        raf.resize(0x54, 0);
        raf.extend(0x5cu32.to_be_bytes());
        raf.extend((pic.len() as u32).to_be_bytes());
        raf.extend(&pic);
        let found = layout(&mut Cursor::new(&raf), raf.len() as u64).unwrap();
        assert_eq!(read_span(&mut Cursor::new(&raf), found.spans[0]).unwrap(), pic);

        let mut prvw = Vec::new();
        prvw.extend(b"PRVW");
        prvw.extend([0u8; 4]);
        prvw.extend([0, 1, 0, 8, 0, 4, 0, 1]);
        prvw.extend((pic.len() as u32).to_be_bytes());
        prvw.extend(&pic);
        let mut uuid = Vec::new();
        uuid.extend(((8 + 16 + 8 + 4 + prvw.len()) as u32).to_be_bytes());
        uuid.extend(b"uuid");
        uuid.extend([0xea; 16]);
        uuid.extend([0u8; 8]);
        uuid.extend(((4 + prvw.len()) as u32).to_be_bytes());
        uuid.extend(&prvw);
        let mut cr3 = Vec::new();
        cr3.extend(16u32.to_be_bytes());
        cr3.extend(b"ftypcrx \0\0\0\x01");
        cr3.extend(uuid);
        let found = layout(&mut Cursor::new(&cr3), cr3.len() as u64).unwrap();
        assert_eq!(read_span(&mut Cursor::new(&cr3), found.spans[0]).unwrap(), pic);
    }

    /// Counts the bytes read from the file.
    struct Counting<R> {
        inner: R,
        read: usize,
    }

    impl<R: Read> Read for Counting<R> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.inner.read(buf)?;
            self.read += n;
            Ok(n)
        }
    }

    impl<R: Seek> Seek for Counting<R> {
        fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
            self.inner.seek(to)
        }
    }

    /// A JPEG header that opens with a frame of the given kind, and is followed by `body` bytes.
    fn frame(marker: u8, body: usize) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0, 0xff, marker, 0, 11, 8, 0, 4, 0, 8, 1, 1, 0x11, 0];
        bytes.resize(bytes.len() + body, 0);
        bytes
    }

    #[test]
    fn a_lossless_span_is_refused_from_its_header_without_reading_its_body() {
        let body = 4 * 1024 * 1024;
        let lossless = frame(0xc3, body);
        let shown = frame(0xc0, 0);
        let mut file = lossless.clone();
        file.extend(&shown);
        let big = Span { offset: 0, len: lossless.len() as u64 };
        let small = Span { offset: lossless.len() as u64, len: shown.len() as u64 };
        let mut reader = Counting { inner: Cursor::new(file), read: 0 };
        assert!(probe(&mut reader, big).is_err());
        assert_eq!(probe(&mut reader, small).unwrap(), (8, 4));
        assert!(reader.read < 1024, "read {} bytes", reader.read);
        let layout = Layout { spans: vec![big, small], orientation: None };
        assert_eq!(choose(&mut reader, &layout, None), vec![small]);
        assert!(reader.read < 1024, "read {} bytes", reader.read);
    }

    #[test]
    fn a_thumbnail_takes_the_smallest_preview_that_is_wide_enough() {
        let picture = |width: u16, height: u16| {
            let mut bytes = frame(0xc0, 0);
            bytes[13..15].copy_from_slice(&height.to_be_bytes());
            bytes[15..17].copy_from_slice(&width.to_be_bytes());
            bytes
        };
        let (tiny, mid, large) = (picture(160, 120), picture(1620, 1080), picture(6000, 4000));
        let mut file = Vec::new();
        let mut spans = Vec::new();
        for bytes in [&tiny, &mid, &large] {
            spans.push(Span { offset: file.len() as u64, len: bytes.len() as u64 });
            file.extend(bytes);
        }
        let layout = Layout { spans: spans.clone(), orientation: None };
        let mut file = Cursor::new(file);
        assert_eq!(choose(&mut file, &layout, None), vec![spans[2], spans[1], spans[0]]);
        assert_eq!(choose(&mut file, &layout, Some(320)), vec![spans[1], spans[2], spans[0]]);
        assert_eq!(choose(&mut file, &layout, Some(2000)), vec![spans[2], spans[1], spans[0]]);
    }

    /// An Olympus file in its real layout: IFD0 names the Exif folder, which holds a maker note whose
    /// camera settings say where the preview is, counted from the start of the maker note.
    #[test]
    fn an_olympus_preview_is_found_through_the_maker_note() {
        let pic = frame(0xc0, 40);
        let entry = |tag: u16, kind: u16, count: u32, value: u32| {
            let mut e = Vec::new();
            e.extend(tag.to_le_bytes());
            e.extend(kind.to_le_bytes());
            e.extend(count.to_le_bytes());
            e.extend(value.to_le_bytes());
            e
        };
        let ifd = |entries: Vec<Vec<u8>>| {
            let mut out = (entries.len() as u16).to_le_bytes().to_vec();
            out.extend(entries.concat());
            out.extend(0u32.to_le_bytes());
            out
        };
        // IFD0 at 8 (one entry), Exif at 26 (one entry), the note at 44.
        let (exif, note) = (8 + 2 + 12 + 4, 8 + 2 + 12 + 4 + 2 + 12 + 4);
        let settings = 12 + 2 + 12 + 4;
        let start = settings + 2 + 2 * 12 + 4;
        let mut out = vec![b'I', b'I', b'R', b'O', 8, 0, 0, 0];
        out.extend(ifd(vec![entry(TAG_EXIF_IFD, 4, 1, exif)]));
        out.extend(ifd(vec![entry(TAG_MAKER_NOTE, 7, start + pic.len() as u32, note)]));
        assert_eq!(out.len() as u32, note);
        out.extend(b"OLYMPUS\0II\x03\0");
        out.extend(ifd(vec![entry(TAG_OLYMPUS_SETTINGS, 13, 1, settings)]));
        out.extend(ifd(vec![
            entry(TAG_OLYMPUS_PREVIEW_START, 4, 1, 12 + 2 + 12 + 4 + 2 + 2 * 12 + 4),
            entry(TAG_OLYMPUS_PREVIEW_BYTES, 4, 1, pic.len() as u32),
        ]));
        out.extend(&pic);
        let found = layout(&mut Cursor::new(&out), out.len() as u64).unwrap();
        assert_eq!(found.spans.len(), 1);
        assert_eq!(read_span(&mut Cursor::new(&out), found.spans[0]).unwrap(), pic);
    }

    #[test]
    fn a_box_size_near_the_limit_of_the_number_ends_the_walk() {
        let mut cr3 = Vec::new();
        cr3.extend(16u32.to_be_bytes());
        cr3.extend(b"ftypcrx \0\0\0\x01");
        cr3.extend(1u32.to_be_bytes());
        cr3.extend(b"uuid");
        cr3.extend((u64::MAX - 4).to_be_bytes());
        let found = layout(&mut Cursor::new(&cr3), cr3.len() as u64).unwrap();
        assert!(found.spans.is_empty());
    }
}
