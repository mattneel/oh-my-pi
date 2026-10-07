//! Cancellable ordinary-byte I/O on an inherited Unix full-duplex descriptor.
//!
//! Adoption duplicates the borrowed descriptor; it never closes the original,
//! including on failure. Successful adoption sets `O_NONBLOCK` on the shared
//! open file description, so the caller must not subsequently clear that flag.
//! There is no terminal probing, raw-mode configuration, or protocol framing.

#[cfg(unix)]
use std::{
	io,
	os::fd::{AsRawFd, FromRawFd, OwnedFd},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
};

use napi::{Error, Result, bindgen_prelude::Buffer};
use napi_derive::napi;
#[cfg(unix)]
use parking_lot::Mutex;
#[cfg(unix)]
use tokio::{
	io::unix::AsyncFd,
	sync::{Semaphore, SemaphorePermit},
};
#[cfg(unix)]
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
const READ_CAPACITY: usize = 64 * 1024;

#[cfg(unix)]
struct Descriptor {
	fd:     OwnedFd,
	socket: bool,
}

#[cfg(unix)]
impl AsRawFd for Descriptor {
	fn as_raw_fd(&self) -> i32 {
		self.fd.as_raw_fd()
	}
}

#[cfg(unix)]
struct Inner {
	fd:              Mutex<Option<Arc<AsyncFd<Descriptor>>>>,
	cancel:          CancellationToken,
	reader:          Semaphore,
	writer:          Semaphore,
	write_remaining: AtomicUsize,
}

#[cfg(unix)]
struct Operation<'a> {
	// Fields drop in declaration order: release the descriptor reference before
	// releasing the permit that close() uses to await operation completion.
	fd:      Arc<AsyncFd<Descriptor>>,
	_permit: SemaphorePermit<'a>,
}

#[cfg(unix)]
struct WriteProgress<'a>(&'a AtomicUsize);

#[cfg(unix)]
impl Drop for WriteProgress<'_> {
	fn drop(&mut self) {
		self.0.store(usize::MAX, Ordering::Relaxed);
	}
}

#[cfg(unix)]
fn closed() -> Error {
	Error::from_reason("DuplexFd is closed")
}

#[cfg(unix)]
fn io_error(operation: &str, error: io::Error) -> Error {
	Error::from_reason(format!("DuplexFd {operation} failed: {error}"))
}

#[cfg(unix)]
impl Inner {
	async fn begin<'a>(&'a self, gate: &'a Semaphore) -> Result<Operation<'a>> {
		let permit = tokio::select! {
			biased;
			() = self.cancel.cancelled() => return Err(closed()),
			permit = gate.acquire() => permit.map_err(|_| closed())?,
		};
		let fd = self.fd.lock().as_ref().cloned().ok_or_else(closed)?;
		Ok(Operation { fd, _permit: permit })
	}

	fn stop(&self) {
		self.cancel.cancel();
		// Take ownership out of the shared state before any await. Even if the
		// close future is dropped, cancelled operations release the last Arc;
		// no background cleanup task or later close call is needed.
		drop(self.fd.lock().take());
	}
}

/// One reader and one writer on an owned duplicate of a borrowed Unix fd.
///
/// Concurrent calls in each direction are serialized. Closing cancels pending
/// and queued I/O with an error; `null` from read means actual peer EOF only.
#[napi]
pub struct DuplexFd {
	#[cfg(unix)]
	inner: Inner,
}

#[napi]
impl DuplexFd {
	/// Duplicate and adopt a descriptor opened for both reading and writing.
	///
	/// The caller retains the original and may close it after this returns.
	/// Sockets and raw PTY endpoints are supported without terminal setup;
	/// descriptors the OS readiness reactor cannot register are rejected.
	/// On failure, the original remains open and its status flags are unchanged.
	/// Non-Unix hosts reject adoption explicitly.
	#[napi(factory)]
	pub fn open(fd: i32) -> Result<Self> {
		#[cfg(unix)]
		{
			// SAFETY: fcntl validates the borrowed integer descriptor. The
			// caller must keep it open until adoption resolves.
			let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
			if duplicate < 0 {
				return Err(io_error("open (duplicate)", io::Error::last_os_error()));
			}
			// SAFETY: duplicate is newly owned, and OwnedFd closes it on every
			// subsequent failure as well as eventual successful teardown.
			let owned = unsafe { OwnedFd::from_raw_fd(duplicate) };
			// SAFETY: owned keeps the descriptor valid for this fcntl call.
			let flags = unsafe { libc::fcntl(owned.as_raw_fd(), libc::F_GETFL) };
			if flags < 0 {
				return Err(io_error("open (flags)", io::Error::last_os_error()));
			}
			if flags & libc::O_ACCMODE != libc::O_RDWR {
				return Err(Error::from_reason(
					"DuplexFd requires a descriptor open for reading and writing",
				));
			}
			let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
			// SAFETY: stat is valid uninitialized output storage and owned is
			// a live descriptor. Only successful fstat initializes the value.
			if unsafe { libc::fstat(owned.as_raw_fd(), stat.as_mut_ptr()) } < 0 {
				return Err(io_error("open (stat)", io::Error::last_os_error()));
			}
			// SAFETY: successful fstat initialized stat above.
			let socket = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT == libc::S_IFSOCK;
			let registered = napi::bindgen_prelude::within_runtime_if_available(|| {
				AsyncFd::new(Descriptor { fd: owned, socket })
			})
			.map_err(|error| io_error("open (readiness registration)", error))?;
			// Register first so reactor rejection cannot mutate the borrowed
			// original's shared flags. Setting nonblocking is the last fallible
			// step, and neither registration nor adoption performs actual I/O.
			if flags & libc::O_NONBLOCK == 0 {
				// SAFETY: registered owns the descriptor; file-status flags are
				// shared with the caller's original as documented above.
				if unsafe {
					libc::fcntl(registered.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK)
				} < 0
				{
					return Err(io_error("open (nonblocking)", io::Error::last_os_error()));
				}
			}
			Ok(Self {
				inner: Inner {
					fd:              Mutex::new(Some(Arc::new(registered))),
					cancel:          CancellationToken::new(),
					reader:          Semaphore::new(1),
					writer:          Semaphore::new(1),
					write_remaining: AtomicUsize::new(usize::MAX),
				},
			})
		}
		#[cfg(not(unix))]
		{
			let _ = fd;
			Err(Error::from_reason("DuplexFd is unix-only"))
		}
	}

	/// Read ordinary bytes without copying or zero-initializing the read buffer.
	/// Returns null only when the descriptor reports EOF.
	#[napi(ts_return_type = "Promise<Buffer | null>")]
	pub async fn read(&self) -> Result<Option<Buffer>> {
		#[cfg(unix)]
		{
			let operation = self.inner.begin(&self.inner.reader).await?;
			let mut bytes = Vec::<u8>::with_capacity(READ_CAPACITY);
			loop {
				let mut ready = tokio::select! {
					biased;
					() = self.inner.cancel.cancelled() => return Err(closed()),
					ready = operation.fd.readable() => ready.map_err(|error| io_error("read readiness", error))?,
				};
				match ready.try_io(|fd| {
					// SAFETY: bytes has READ_CAPACITY writable spare bytes; its
					// length remains zero until read initializes the returned count.
					// The operation owns fd and guarantees nonblocking lifetime.
					let count =
						unsafe { libc::read(fd.as_raw_fd(), bytes.as_mut_ptr().cast(), READ_CAPACITY) };
					if count < 0 {
						Err(io::Error::last_os_error())
					} else {
						Ok(count as usize)
					}
				}) {
					Ok(Ok(0)) => return Ok(None),
					Ok(Ok(count)) => {
						// SAFETY: read initialized exactly count bytes in the buffer.
						unsafe { bytes.set_len(count) };
						return Ok(Some(Buffer::from(bytes)));
					},
					Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {},
					Ok(Err(error)) => return Err(io_error("read", error)),
					Err(_) => {}, // WouldBlock cleared the readiness notification.
				}
			}
		}
		#[cfg(not(unix))]
		{
			Err(Error::from_reason("DuplexFd is unix-only"))
		}
	}

	/// Bytes still unwritten by the active write, including partial syscall
	/// progress. Null when no write is active; queued calls have not acquired
	/// the writer.
	#[napi(getter)]
	pub fn pending_write_bytes(&self) -> Option<u32> {
		#[cfg(unix)]
		{
			let remaining = self.inner.write_remaining.load(Ordering::Relaxed);
			(remaining != usize::MAX).then(|| remaining.min(u32::MAX as usize) as u32)
		}
		#[cfg(not(unix))]
		{
			None
		}
	}

	/// Write all bytes, awaiting readiness under backpressure. Cancellation or
	/// another error can leave a prefix written; no unwritten bytes are queued.
	#[napi]
	pub async fn write(&self, bytes: Buffer) -> Result<()> {
		#[cfg(unix)]
		{
			let operation = self.inner.begin(&self.inner.writer).await?;
			let _progress = WriteProgress(&self.inner.write_remaining);
			self
				.inner
				.write_remaining
				.store(bytes.len(), Ordering::Relaxed);
			let mut offset = 0;
			while offset < bytes.len() {
				let mut ready = tokio::select! {
					biased;
					() = self.inner.cancel.cancelled() => return Err(closed()),
					ready = operation.fd.writable() => ready.map_err(|error| io_error("write readiness", error))?,
				};
				match ready.try_io(|fd| {
					let descriptor = fd.get_ref();
					let remaining = &bytes[offset..];
					// SAFETY: remaining is initialized storage and the operation
					// keeps the nonblocking descriptor alive throughout the call.
					// send suppresses SIGPIPE for sockets; PTYs use ordinary write.
					let count = unsafe {
						if descriptor.socket {
							libc::send(
								descriptor.as_raw_fd(),
								remaining.as_ptr().cast(),
								remaining.len(),
								libc::MSG_NOSIGNAL,
							)
						} else {
							libc::write(descriptor.as_raw_fd(), remaining.as_ptr().cast(), remaining.len())
						}
					};
					if count < 0 {
						Err(io::Error::last_os_error())
					} else {
						Ok(count as usize)
					}
				}) {
					Ok(Ok(0)) => return Err(io_error("write", io::ErrorKind::WriteZero.into())),
					Ok(Ok(count)) => {
						offset += count;
						self
							.inner
							.write_remaining
							.store(bytes.len() - offset, Ordering::Relaxed);
					},
					Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {},
					Ok(Err(error)) => return Err(io_error("write", error)),
					Err(_) => {},
				}
			}
			Ok(())
		}
		#[cfg(not(unix))]
		{
			let _ = bytes;
			Err(Error::from_reason("DuplexFd is unix-only"))
		}
	}

	/// Idempotently cancel I/O and release the duplicate before resolving.
	/// Dropping this future after its first poll does not abandon cleanup.
	#[napi]
	pub async fn close(&self) -> Result<()> {
		#[cfg(unix)]
		{
			self.inner.stop();
			// All operation references are gone before these permits become
			// available. New operations see cancellation or the empty fd slot.
			let _reader = self.inner.reader.acquire().await.map_err(|_| closed())?;
			let _writer = self.inner.writer.acquire().await.map_err(|_| closed())?;
			Ok(())
		}
		#[cfg(not(unix))]
		{
			Err(Error::from_reason("DuplexFd is unix-only"))
		}
	}
}

impl Drop for DuplexFd {
	fn drop(&mut self) {
		#[cfg(unix)]
		self.inner.stop();
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{os::unix::net::UnixStream, time::Duration};

	use tokio::{
		io::{AsyncReadExt, AsyncWriteExt},
		net::UnixStream as AsyncUnixStream,
		time::timeout,
	};

	use super::*;

	const DEADLINE: Duration = Duration::from_secs(2);

	fn socket_pair() -> (DuplexFd, AsyncUnixStream) {
		let (original, peer) = UnixStream::pair().unwrap();
		let duplex = DuplexFd::open(original.as_raw_fd()).unwrap();
		drop(original);
		peer.set_nonblocking(true).unwrap();
		(duplex, AsyncUnixStream::from_std(peer).unwrap())
	}

	async fn read_exact(duplex: &DuplexFd, expected: &[u8]) {
		let mut received = Vec::new();
		while received.len() < expected.len() {
			let bytes = timeout(DEADLINE, duplex.read())
				.await
				.unwrap()
				.unwrap()
				.expect("unexpected EOF");
			received.extend_from_slice(&bytes);
		}
		assert_eq!(received, expected);
	}

	fn weak_descriptor(duplex: &DuplexFd) -> std::sync::Weak<AsyncFd<Descriptor>> {
		Arc::downgrade(duplex.inner.fd.lock().as_ref().unwrap())
	}

	#[tokio::test]
	async fn socketpair_exchanges_binary_bytes_in_both_directions() {
		let (duplex, mut peer) = socket_pair();
		let bytes = b"ordinary\0bytes\r\n\x1b[31m\xff";
		peer.write_all(bytes).await.unwrap();
		read_exact(&duplex, bytes).await;
		timeout(DEADLINE, duplex.write(Buffer::from(bytes.as_slice())))
			.await
			.unwrap()
			.unwrap();
		let mut received = vec![0; bytes.len()];
		timeout(DEADLINE, peer.read_exact(&mut received))
			.await
			.unwrap()
			.unwrap();
		assert_eq!(received, bytes);
		duplex.close().await.unwrap();
	}

	#[tokio::test]
	async fn write_all_drains_backpressure_while_read_direction_remains_live() {
		let (duplex, peer) = socket_pair();
		let payload = vec![b'x'; 1024 * 1024];
		let (mut reader, mut writer) = peer.into_split();
		let received = timeout(DEADLINE, async {
			let send = duplex.write(Buffer::from(payload.clone()));
			let receive = async {
				let mut bytes = vec![0; payload.len()];
				reader.read_exact(&mut bytes).await.unwrap();
				bytes
			};
			let reverse = async {
				writer.write_all(b"reverse").await.unwrap();
				read_exact(&duplex, b"reverse").await;
			};
			let (sent, bytes, ()) = tokio::join!(send, receive, reverse);
			sent.unwrap();
			bytes
		})
		.await
		.unwrap();
		assert_eq!(received, payload);
		duplex.close().await.unwrap();
	}

	#[tokio::test]
	async fn pending_write_reports_partial_drain_before_write_all_finishes() {
		let (duplex, mut peer) = socket_pair();
		let send = duplex.write(Buffer::from(vec![b'x'; 1024 * 1024]));
		tokio::pin!(send);
		assert_eq!(duplex.pending_write_bytes(), None);
		timeout(DEADLINE, async {
			loop {
				assert!(futures::poll!(&mut send).is_pending());
				if duplex
					.pending_write_bytes()
					.is_some_and(|remaining| remaining < 1024 * 1024)
				{
					break;
				}
				tokio::task::yield_now().await;
			}
		})
		.await
		.unwrap();
		let initial = duplex.pending_write_bytes().unwrap();
		let mut received = vec![0; 1024 * 1024 - initial as usize];
		timeout(DEADLINE, peer.read_exact(&mut received))
			.await
			.unwrap()
			.unwrap();
		assert!(received.iter().all(|byte| *byte == b'x'));
		timeout(DEADLINE, async {
			loop {
				assert!(futures::poll!(&mut send).is_pending());
				if duplex.pending_write_bytes().unwrap() < initial {
					break;
				}
				tokio::task::yield_now().await;
			}
		})
		.await
		.unwrap();
		let (closed, sent) = tokio::join!(duplex.close(), send);
		closed.unwrap();
		assert!(sent.is_err());
		assert_eq!(duplex.pending_write_bytes(), None);
	}

	#[tokio::test]
	async fn peer_eof_does_not_disable_write_direction() {
		let (duplex, mut peer) = socket_pair();
		peer.shutdown().await.unwrap();
		assert!(
			timeout(DEADLINE, duplex.read())
				.await
				.unwrap()
				.unwrap()
				.is_none()
		);
		duplex
			.write(Buffer::from(b"still writable".as_slice()))
			.await
			.unwrap();
		let mut bytes = [0; 14];
		timeout(DEADLINE, peer.read_exact(&mut bytes))
			.await
			.unwrap()
			.unwrap();
		assert_eq!(&bytes, b"still writable");
		duplex.close().await.unwrap();
	}

	#[tokio::test]
	async fn close_cancels_active_and_queued_reads_and_releases_descriptor() {
		let (duplex, mut peer) = socket_pair();
		let weak = weak_descriptor(&duplex);
		let active = duplex.read();
		let queued = duplex.read();
		tokio::pin!(active, queued);
		assert!(futures::poll!(&mut active).is_pending());
		assert_eq!(duplex.inner.reader.available_permits(), 0);
		assert!(futures::poll!(&mut queued).is_pending());
		let (closed, active, queued) =
			timeout(DEADLINE, async { tokio::join!(duplex.close(), active, queued) })
				.await
				.unwrap();
		closed.unwrap();
		assert!(active.is_err());
		assert!(queued.is_err());
		assert!(weak.upgrade().is_none());
		assert_eq!(
			timeout(DEADLINE, peer.read(&mut [0]))
				.await
				.unwrap()
				.unwrap(),
			0
		);
		duplex.close().await.unwrap();
		assert!(duplex.read().await.is_err());
		assert!(duplex.write(Buffer::from(Vec::new())).await.is_err());
	}

	#[tokio::test]
	async fn close_cancels_backpressured_write_and_pending_read_together() {
		let (duplex, _peer) = socket_pair();
		let weak = weak_descriptor(&duplex);
		let fd = duplex.inner.fd.lock().as_ref().unwrap().as_raw_fd();
		let fill = [b'x'; 16 * 1024];
		loop {
			// SAFETY: duplex owns the socket, adoption set nonblocking, and
			// fill is a valid input slice. The peer deliberately never reads.
			let count =
				unsafe { libc::send(fd, fill.as_ptr().cast(), fill.len(), libc::MSG_NOSIGNAL) };
			if count < 0 {
				let error = io::Error::last_os_error();
				if error.kind() == io::ErrorKind::Interrupted {
					continue;
				}
				assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
				break;
			}
			assert!(count > 0);
		}
		let read = duplex.read();
		let write = duplex.write(Buffer::from(fill.as_slice()));
		let queued_write = duplex.write(Buffer::from(b"queued".as_slice()));
		tokio::pin!(read, write, queued_write);
		assert!(futures::poll!(&mut read).is_pending());
		assert!(futures::poll!(&mut write).is_pending());
		assert_eq!(duplex.inner.writer.available_permits(), 0);
		assert!(futures::poll!(&mut queued_write).is_pending());
		let (closed, read, write, queued_write) =
			timeout(DEADLINE, async { tokio::join!(duplex.close(), read, write, queued_write) })
				.await
				.unwrap();
		closed.unwrap();
		assert!(read.is_err());
		assert!(write.is_err());
		assert!(queued_write.is_err());
		assert!(weak.upgrade().is_none());
		duplex.close().await.unwrap();
	}

	#[tokio::test]
	async fn dropping_close_future_does_not_abandon_descriptor_cleanup() {
		let (duplex, mut peer) = socket_pair();
		let weak = weak_descriptor(&duplex);
		let read = duplex.read();
		tokio::pin!(read);
		assert!(futures::poll!(&mut read).is_pending());
		{
			let close = duplex.close();
			tokio::pin!(close);
			assert!(futures::poll!(&mut close).is_pending());
		}
		assert!(timeout(DEADLINE, read).await.unwrap().is_err());
		assert!(weak.upgrade().is_none());
		assert_eq!(
			timeout(DEADLINE, peer.read(&mut [0]))
				.await
				.unwrap()
				.unwrap(),
			0
		);
		duplex.close().await.unwrap();
	}

	#[tokio::test]
	async fn adoption_and_close_leave_borrowed_original_owned_by_caller() {
		let (original, mut peer) = UnixStream::pair().unwrap();
		let duplex = DuplexFd::open(original.as_raw_fd()).unwrap();
		// SAFETY: original is still held by this test.
		let flags = unsafe { libc::fcntl(original.as_raw_fd(), libc::F_GETFL) };
		assert_ne!(flags & libc::O_NONBLOCK, 0);
		duplex.close().await.unwrap();
		duplex.close().await.unwrap();
		// SAFETY: close must not close the caller's borrowed original.
		assert_eq!(unsafe { libc::fcntl(original.as_raw_fd(), libc::F_GETFL) }, flags);
		peer.set_nonblocking(true).unwrap();
		use std::io::Read;
		assert_eq!(peer.read(&mut [0]).unwrap_err().kind(), io::ErrorKind::WouldBlock);
		drop(original);
		assert_eq!(peer.read(&mut [0]).unwrap(), 0);
	}

	#[tokio::test]
	async fn invalid_and_one_way_adoption_preserve_originals_and_flags() {
		assert!(DuplexFd::open(-1).is_err());
		let mut fds = [-1; 2];
		// SAFETY: fds provides the two output slots for pipe.
		assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
		// SAFETY: pipe returned two newly owned descriptors.
		let reader = unsafe { OwnedFd::from_raw_fd(fds[0]) };
		// SAFETY: the second pipe descriptor has not been adopted elsewhere.
		let writer = unsafe { OwnedFd::from_raw_fd(fds[1]) };
		for original in [&reader, &writer] {
			// SAFETY: each original remains owned throughout this loop.
			let flags = unsafe { libc::fcntl(original.as_raw_fd(), libc::F_GETFL) };
			assert!(DuplexFd::open(original.as_raw_fd()).is_err());
			// SAFETY: failed adoption must leave the original open and unchanged.
			assert_eq!(unsafe { libc::fcntl(original.as_raw_fd(), libc::F_GETFL) }, flags);
		}
	}

	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn reactor_rejection_preserves_borrowed_descriptor_and_status_flags() {
		let original = std::fs::OpenOptions::new()
			.read(true)
			.write(true)
			.open("/dev/null")
			.unwrap();
		// SAFETY: original remains owned throughout the rejected adoption.
		let flags = unsafe { libc::fcntl(original.as_raw_fd(), libc::F_GETFL) };
		assert!(DuplexFd::open(original.as_raw_fd()).is_err());
		// SAFETY: even reactor registration failure must retain the original.
		assert_eq!(unsafe { libc::fcntl(original.as_raw_fd(), libc::F_GETFL) }, flags);
	}

	#[tokio::test]
	async fn drop_releases_descriptor_without_explicit_close() {
		let (duplex, mut peer) = socket_pair();
		let weak = weak_descriptor(&duplex);
		drop(duplex);
		assert!(weak.upgrade().is_none());
		assert_eq!(
			timeout(DEADLINE, peer.read(&mut [0]))
				.await
				.unwrap()
				.unwrap(),
			0
		);
	}

	#[tokio::test]
	async fn raw_pty_exchanges_ordinary_bytes_without_terminal_configuration() {
		let (mut master, mut slave) = (-1, -1);
		// SAFETY: master/slave are valid output slots; null optional arguments
		// request default terminal settings, configured by the host below.
		assert_eq!(
			unsafe {
				libc::openpty(
					&mut master,
					&mut slave,
					std::ptr::null_mut(),
					std::ptr::null_mut(),
					std::ptr::null_mut(),
				)
			},
			0
		);
		// SAFETY: openpty returned distinct newly owned descriptors.
		let master = unsafe { OwnedFd::from_raw_fd(master) };
		// SAFETY: the slave descriptor has not been adopted elsewhere.
		let slave = unsafe { OwnedFd::from_raw_fd(slave) };
		let mut termios = std::mem::MaybeUninit::<libc::termios>::uninit();
		// SAFETY: slave is live, termios is valid output storage.
		assert_eq!(unsafe { libc::tcgetattr(slave.as_raw_fd(), termios.as_mut_ptr()) }, 0);
		// SAFETY: tcgetattr initialized termios successfully.
		let mut termios = unsafe { termios.assume_init() };
		// Host setup alone configures raw mode; DuplexFd must leave it untouched.
		// SAFETY: termios is initialized and slave remains open.
		unsafe { libc::cfmakeraw(&mut termios) };
		// SAFETY: termios is a valid input struct for the owned slave.
		assert_eq!(unsafe { libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &termios) }, 0);
		let endpoint = DuplexFd::open(slave.as_raw_fd()).unwrap();
		let host = DuplexFd::open(master.as_raw_fd()).unwrap();
		drop(slave);
		drop(master);
		let bytes = b"ordinary\0\r\n\x03\x1b[2J\xff";
		timeout(DEADLINE, host.write(Buffer::from(bytes.as_slice())))
			.await
			.unwrap()
			.unwrap();
		read_exact(&endpoint, bytes).await;
		timeout(DEADLINE, endpoint.write(Buffer::from(bytes.as_slice())))
			.await
			.unwrap()
			.unwrap();
		read_exact(&host, bytes).await;
		endpoint.close().await.unwrap();
		host.close().await.unwrap();
	}
}
