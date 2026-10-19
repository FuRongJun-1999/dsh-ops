//! Windows-only FFI boundary. Callers supply owned/borrowed file handles; no
//! model paths, shells, privilege enabling, or publication policy live here.
#![cfg(windows)]
use std::{
    ffi::c_void,
    fs::File,
    io,
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, FromRawHandle},
    ptr::{addr_of_mut, null_mut},
};
use winapi::shared::ntdef::{OBJECT_ATTRIBUTES, UNICODE_STRING};
use windows_permissions::{
    LocalBox, SecurityDescriptor,
    constants::{SeObjectType::SE_FILE_OBJECT, SecurityInformation as Info},
    wrappers,
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Security::{
        GetSecurityDescriptorControl, SetKernelObjectSecurity, SetSecurityDescriptorControl,
    },
    Storage::FileSystem::{
        FILE_BASIC_INFO, FILE_STREAM_INFO, FileBasicInfo, FileStreamInfo,
        GetFileInformationByHandleEx, SetFileInformationByHandle,
    },
};

#[repr(C)]
struct IoStatus {
    status: usize,
    information: usize,
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        handle: *mut HANDLE,
        access: u32,
        attributes: *const OBJECT_ATTRIBUTES,
        status: *mut IoStatus,
        size: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: *const c_void,
        ea_length: u32,
    ) -> i32;
    fn NtQueryInformationFile(
        handle: HANDLE,
        status: *mut IoStatus,
        information: *mut c_void,
        length: u32,
        class: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}
fn unsupported(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, message)
}
fn nt_error(status: i32) -> io::Error {
    // SAFETY: total scalar conversion, no pointer arguments.
    io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
}
fn info() -> Info {
    Info::Owner | Info::Group | Info::Dacl
}
fn descriptor(file: &File) -> io::Result<LocalBox<SecurityDescriptor>> {
    wrappers::GetSecurityInfo(file, SE_FILE_OBJECT, info())
}
fn sddl(sd: &SecurityDescriptor) -> io::Result<std::ffi::OsString> {
    wrappers::ConvertSecurityDescriptorToStringSecurityDescriptor(sd, info())
}
fn control(sd: &SecurityDescriptor) -> io::Result<u16> {
    let mut flags = 0;
    let mut revision = 0;
    // SAFETY: sd is an OS-allocated valid descriptor, output scalars are live.
    if unsafe { GetSecurityDescriptorControl(sd as *const _ as *mut _, &mut flags, &mut revision) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    // DACL present/defaulted, auto-inherit requested/inherited, protected.
    Ok(flags & 0x150f)
}

/// CREATE_NEW relative to a held directory, with a protected current-process
/// user DACL at creation, before any bytes can be written. No inherited grants.
pub fn create_private(parent: &File, name: &str) -> io::Result<File> {
    if name.is_empty() || name.contains(['/', '\\', ':', '\0']) || name == "." || name == ".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a single sibling name",
        ));
    }
    let sid = windows_permissions::utilities::current_process_sid()?;
    let private: LocalBox<SecurityDescriptor> = format!("D:P(A;;FA;;;{sid})").parse()?;
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    let length = u16::try_from(wide.len() * 2)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Sibling name too long"))?;
    let mut unicode = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &mut unicode,
        Attributes: 0x40, // OBJ_CASE_INSENSITIVE
        SecurityDescriptor: &*private as *const _ as *mut _,
        SecurityQualityOfService: null_mut(),
    };
    let mut handle = null_mut();
    let mut status = IoStatus {
        status: 0,
        information: 0,
    };
    // SAFETY: parent is borrowed for the syscall; unicode and descriptor storage
    // outlive the call. FILE_CREATE is exclusive; NON_DIRECTORY|OPEN_REPARSE_POINT
    // forbids traversal of the leaf. The returned handle is adopted exactly once.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            0xc00f0000 | 0x00100000, // GENERIC_READ|WRITE, STANDARD_RIGHTS_ALL, SYNCHRONIZE
            &attributes,
            &mut status,
            std::ptr::null(),
            0x80,                     // FILE_ATTRIBUTE_NORMAL
            7,                        // FILE_SHARE_READ|WRITE|DELETE
            2,                        // FILE_CREATE (never overwrite)
            0x00200000 | 0x40 | 0x20, // OPEN_REPARSE_POINT|NON_DIRECTORY|SYNCHRONOUS_IO_NONALERT
            std::ptr::null(),
            0,
        )
    };
    if result < 0 {
        return Err(nt_error(result));
    }
    // SAFETY: successful NtCreateFile transferred one live owned file handle.
    let file = unsafe { File::from_raw_handle(handle) };
    let verified = (|| -> io::Result<()> {
        let actual = descriptor(&file)?;
        let actual_dacl = sddl(&actual)?
            .to_string_lossy()
            .split("D:")
            .nth(1)
            .unwrap_or("")
            .replace("AI", "");
        let expected = sddl(&private)?.to_string_lossy().into_owned();
        if actual_dacl != expected.trim_start_matches("D:") {
            return Err(unsupported("Private creation DACL verification failed"));
        }
        Ok(())
    })();
    if let Err(error) = verified {
        let _ = discard(&file);
        return Err(error);
    }
    Ok(file)
}

/// Captures mandatory security and supported basic metadata. Named streams,
/// extended attributes, EFS/compression/sparse/other special storage fail closed.
pub struct Metadata {
    sd: LocalBox<SecurityDescriptor>,
    basic: FILE_BASIC_INFO,
}
impl Metadata {
    pub fn capture(file: &File) -> io::Result<Self> {
        // SAFETY: zero is a valid initial output struct; API writes its full size.
        let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                addr_of_mut!(basic).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if basic.FileAttributes & !(0x1 | 0x2 | 0x4 | 0x20 | 0x80 | 0x100 | 0x2000) != 0 {
            return Err(unsupported(
                "Special Windows storage attributes are not supported",
            ));
        }
        // SAFETY: aligned buffer is writable for its advertised byte size. The
        // only accepted record is one fixed, bounded unnamed data stream.
        let mut streams = vec![0u64; 8192];
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileStreamInfo,
                streams.as_mut_ptr().cast(),
                (streams.len() * 8) as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(234 | 122)) {
                return Err(unsupported(
                    "Windows stream metadata exceeds the bounded capture budget",
                ));
            }
            return Err(error);
        }
        // SAFETY: the aligned allocation holds a full FILE_STREAM_INFO; Windows
        // returned success, and name length/next offset are checked before use.
        let stream = unsafe { &*streams.as_ptr().cast::<FILE_STREAM_INFO>() };
        if stream.NextEntryOffset != 0 || stream.StreamNameLength != 14 {
            return Err(unsupported("Named Windows streams are not supported"));
        }
        // SAFETY: 14 name bytes fit in the 64KiB allocation after the fixed header.
        let name = unsafe { std::slice::from_raw_parts(stream.StreamName.as_ptr(), 7) };
        if name != "::$DATA".encode_utf16().collect::<Vec<_>>() {
            return Err(unsupported("Unknown Windows stream metadata"));
        }
        let mut ea_size = 0u32;
        let mut status = IoStatus {
            status: 0,
            information: 0,
        };
        // SAFETY: FileEaInformation (7) writes one ULONG into ea_size.
        let result = unsafe {
            NtQueryInformationFile(
                file.as_raw_handle(),
                &mut status,
                addr_of_mut!(ea_size).cast(),
                4,
                7,
            )
        };
        if result < 0 {
            return Err(nt_error(result));
        }
        if ea_size != 0 {
            return Err(unsupported("Windows extended attributes are not supported"));
        }
        Ok(Self {
            sd: descriptor(file)?,
            basic,
        })
    }
    pub fn readonly(&self) -> bool {
        self.basic.FileAttributes & 1 != 0
    }
    pub fn restore(&self, file: &File) -> io::Result<()> {
        let original_control = control(&self.sd)?;
        let mut working: LocalBox<SecurityDescriptor> =
            sddl(&self.sd)?.to_string_lossy().parse()?;
        // SAFETY: working is freshly allocated and exclusively owned here.
        // AR is an input request consumed by the kernel into AI.
        if unsafe {
            SetSecurityDescriptorControl(
                &mut *working as *mut _ as *mut _,
                0x0100,
                if original_control & 0x0400 != 0 {
                    0x0100
                } else {
                    0
                },
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: borrowed handle and OS-owned valid descriptor. No privilege is
        // enabled; inability to restore a different owner aborts publication.
        let result = unsafe {
            SetKernelObjectSecurity(
                file.as_raw_handle(),
                info().bits(),
                &mut *working as *mut _ as *mut _,
            )
        };
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: FILE_BASIC_INFO is fully initialized and borrowed for the call.
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileBasicInfo,
                &self.basic as *const _ as *const _,
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        self.verify(file)
    }
    pub fn verify(&self, file: &File) -> io::Result<()> {
        let actual = descriptor(file)?;
        if actual.owner() != self.sd.owner()
            || actual.group() != self.sd.group()
            || sddl(&actual)? != sddl(&self.sd)?
            || control(&actual)? != control(&self.sd)?
        {
            return Err(unsupported(
                "Windows owner/group/DACL/control preservation verification failed",
            ));
        }
        // SAFETY: fixed-size initialized output for the borrowed live handle.
        let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                addr_of_mut!(basic).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if basic.FileAttributes != self.basic.FileAttributes
            || basic.CreationTime != self.basic.CreationTime
            || basic.LastWriteTime != self.basic.LastWriteTime
        {
            return Err(unsupported("Windows basic metadata verification failed"));
        }
        Ok(())
    }
}

/// Remove only the link associated with this staged handle, even if captured
/// readonly attributes were restored. Other hardlinks keep their attributes.
pub fn discard(file: &File) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FileDispositionInfoEx,
    };
    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    // SAFETY: borrowed live DELETE-capable staging handle; initialized fixed-size
    // input. This unlinks its own staging name, never changes inode permissions.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfoEx,
            &disposition as *const _ as *const _,
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        os::windows::fs::OpenOptionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn staging_is_private_before_bytes_and_exclusive() {
        let root = std::env::temp_dir().join(format!(
            "dsh-metadata-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let parent = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .open(&root)
            .unwrap();
        let mut file = create_private(&parent, "private").unwrap();
        let sd = descriptor(&file).unwrap();
        let sid = windows_permissions::utilities::current_process_sid().unwrap();
        assert!(
            sddl(&sd)
                .unwrap()
                .to_string_lossy()
                .ends_with(&format!("D:P(A;;FA;;;{sid})"))
        );
        assert_eq!(file.metadata().unwrap().len(), 0);
        assert_eq!(
            create_private(&parent, "private").unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        file.write_all(b"private bytes").unwrap();
        assert!(create_private(&parent, "../escape").is_err());
        discard(&file).unwrap();
        drop(file);
        drop(parent);
        assert!(!root.join("private").exists());
        std::fs::remove_dir(root).unwrap();
    }
}
