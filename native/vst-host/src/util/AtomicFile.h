// Crash-safe file replacement: a reader never observes a half-written state file.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace thedaw::util {

bool fileExists(const std::wstring& path);

bool readFile(const std::wstring& path, std::vector<uint8_t>& out, std::string& error);

// Writes to "<path>.<pid>.tmp", flushes it to disk, then replaces `path` with a
// single MoveFileExW. The temporary file is removed on any failure.
bool writeFileAtomic(const std::wstring& path, const void* data, size_t size,
                     std::string& error);

}  // namespace thedaw::util
