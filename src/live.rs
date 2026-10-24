//! What changed in the served folder, told to every open page as it happens.
//! The index tells the feed and each page reads it over one stream. The feed keeps
//! nothing per page beyond a short line of changes still waiting for it, so a page
//! that is slow or stuck costs the others, the watcher and the index nothing.

use futures_util::Stream;
use futures_util::stream;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio_util::sync::CancellationToken;

/// How many changes wait for a page. One that falls further behind is told to read
/// everything again and is sent none of them.
const BACKLOG: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// Something in one folder is not what it was: an entry came, went or was renamed,
    /// or a file in it was written.
    Folder {
        /// The folder's real place, relative to the served folder.
        dir: String,
        /// The files in it that were written.
        files: Vec<String>,
    },
    /// More changed than is named: read again whatever is on screen.
    Sync,
    /// Something went into the Trash or left it.
    Trash,
}

pub struct Feed {
    send: broadcast::Sender<Change>,
    closed: CancellationToken,
}

impl Default for Feed {
    fn default() -> Self {
        Self {
            send: broadcast::channel(BACKLOG).0,
            closed: CancellationToken::new(),
        }
    }
}

impl Feed {
    /// Tells every page that is reading. Never waits for one.
    pub fn tell(&self, change: Change) {
        // An error only says that no page is reading.
        let _ = self.send.send(change);
    }

    /// Ends every stream, so that the server can stop while pages are open.
    pub fn close(&self) {
        self.closed.cancel();
    }

    /// The changes from now on, for one page.
    pub fn follow(&self) -> impl Stream<Item = Change> + Send + use<> {
        let state = (self.send.subscribe(), self.closed.clone());
        stream::unfold(state, |(mut waiting, closed)| async move {
            let change = tokio::select! {
                () = closed.cancelled() => return None,
                next = waiting.recv() => match next {
                    Ok(change) => change,
                    Err(RecvError::Lagged(_)) => {
                        // What it missed is skipped, not sent late.
                        waiting = waiting.resubscribe();
                        Change::Sync
                    }
                    Err(RecvError::Closed) => return None,
                },
            };
            Some((change, (waiting, closed)))
        })
    }
}

#[cfg(test)]
mod tests {
    use futures_util::{FutureExt, StreamExt};

    use super::*;

    fn folder(dir: &str) -> Change {
        Change::Folder {
            dir: dir.to_owned(),
            files: Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_page_hears_changes_in_order() {
        let feed = Feed::default();
        let mut page = Box::pin(feed.follow());
        feed.tell(folder("a"));
        feed.tell(folder("b"));
        assert_eq!(page.next().await, Some(folder("a")));
        assert_eq!(page.next().await, Some(folder("b")));
        assert_eq!(page.next().now_or_never(), None, "nothing more is waiting");
    }

    #[tokio::test]
    async fn a_page_that_falls_behind_is_told_to_catch_up_and_gets_no_backlog() {
        let feed = Feed::default();
        let mut slow = Box::pin(feed.follow());
        for at in 0..BACKLOG * 3 {
            feed.tell(folder(&at.to_string()));
        }
        assert_eq!(slow.next().await, Some(Change::Sync));
        assert_eq!(
            slow.next().now_or_never(),
            None,
            "the changes it missed are not sent late"
        );

        // It is in step again: the next change reaches it as usual.
        feed.tell(folder("after"));
        assert_eq!(slow.next().await, Some(folder("after")));
    }

    #[tokio::test]
    async fn closing_the_feed_ends_every_stream() {
        let feed = Feed::default();
        let mut page = Box::pin(feed.follow());
        feed.close();
        assert_eq!(page.next().await, None);
    }
}
