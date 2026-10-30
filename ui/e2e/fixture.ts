// The folder okfs serves in the browser tests: pictures, a PDF, Markdown, code, a CSV and a nested folder.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/** How many pictures `photos/` holds: the speed guard holds a key across all of them. */
export const PHOTOS = 40;

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
}

/** A PNG of one color, `size` pixels square. */
export function png(size: number, [red, green, blue]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([red, green, blue], 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A one page PDF with a line of text. */
export function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Writes the fixture into `root`, which exists. */
export function build(root: string): void {
  mkdirSync(join(root, "photos"));
  for (let i = 0; i < PHOTOS; i++) {
    const shade = Math.round((i / PHOTOS) * 200);
    writeFileSync(join(root, "photos", `photo-${String(i).padStart(2, "0")}.png`), png(320 + i, [shade, 90, 200 - shade]));
  }
  writeFileSync(join(root, "poster.png"), png(96, [200, 60, 60]));
  writeFileSync(join(root, "paper.pdf"), pdf("Quarterly paper"));
  writeFileSync(join(root, "notes.md"), "# Field notes\n\nSome **bold** words and a [link](https://example.com).\n\n- first\n- second\n");
  writeFileSync(join(root, "main.rs"), 'fn main() {\n    println!("hello from the fixture");\n}\n');
  writeFileSync(join(root, "table.csv"), "name,count\napples,3\npears,5\n");
  mkdirSync(join(root, "deep", "deeper"), { recursive: true });
  writeFileSync(join(root, "deep", "deeper", "needle-in-haystack.txt"), "found me\n");
  writeFileSync(join(root, "deep", "readme.txt"), "a nested folder\n");
}
