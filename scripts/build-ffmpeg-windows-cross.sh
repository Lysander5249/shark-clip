#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Run this cross build on macOS. Use build-ffmpeg-windows.sh on Windows.' >&2
  exit 1
fi
if [[ "$#" != 0 ]]; then
  echo 'The cross build takes no arguments and targets Windows x64.' >&2
  exit 1
fi

script_dir=$(cd "$(dirname "$0")" && pwd)
project_dir=$(cd "$script_dir/.." && pwd)
build_dir=${CLIP_FETCHER_BUILD_DIR:-"$project_dir/work/windows-build"}
case "$build_dir" in
  /*) ;;
  *) build_dir="$PWD/$build_dir" ;;
esac
downloads="$build_dir/downloads"
prefix="$build_dir/ffmpeg/win-x64"
ffmpeg_archive=ffmpeg-9.0.2.tar.xz
ffmpeg_sha=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
zlib_archive=zlib-1.4.tar.xz
zlib_sha=4f11c512053d7bab8d9e9b89bde3575add3e4c50a383b42ef6cb837035fc5a7c
toolchain_name=llvm-mingw-20261104-ucrt-macos-universal
toolchain_archive="$toolchain_name.tar.xz"
toolchain_sha=66cbd5178c4a71b0d473e68ede172f8eb7d15d023e67f39201d0a69e21f6bf3c

ffmpeg_path="$downloads/$ffmpeg_archive"
zlib_path="$downloads/$zlib_archive"
if [[ -f "$script_dir/$ffmpeg_archive" && -f "$script_dir/$zlib_archive" ]]; then
  ffmpeg_path="$script_dir/$ffmpeg_archive"
  zlib_path="$script_dir/$zlib_archive"
elif [[ ! -f "$ffmpeg_path" ]]; then
  ffmpeg_path="$project_dir/work/subtitle-media-build/downloads/$ffmpeg_archive"
fi

check_archive() {
  if [[ ! -f "$2" ]]; then
    echo "Missing pinned build input: $2" >&2
    return 1
  fi
  printf '%s  %s\n' "$1" "$2" | /usr/bin/shasum -a 256 -c -
}
check_archive "$toolchain_sha" "$downloads/$toolchain_archive"
check_archive "$ffmpeg_sha" "$ffmpeg_path"
check_archive "$zlib_sha" "$zlib_path"
if [[ -e "$prefix" ]]; then
  echo "Build output already exists: $prefix. Set CLIP_FETCHER_BUILD_DIR for a separate build." >&2
  exit 1
fi

# FFmpeg configure and make expect simple build paths. Keep all temporary
# source/toolchain paths ASCII even if the checkout path contains spaces.
stage=$(mktemp -d /tmp/clip-fetcher-winx64.XXXXXX)
cleanup() {
  local status=$?
  if [[ "$status" != 0 && -f "$stage/build/ffbuild/config.log" ]]; then
    mkdir -p "$build_dir"
    cp "$stage/build/ffbuild/config.log" "$build_dir/ffmpeg-cross-config.log"
  fi
  rm -rf "$stage"
}
trap cleanup EXIT

/usr/bin/tar -xf "$downloads/$toolchain_archive" -C "$stage"
/usr/bin/tar -xf "$ffmpeg_path" -C "$stage"
/usr/bin/tar -xf "$zlib_path" -C "$stage"
toolchain="$stage/$toolchain_name"
cross="$toolchain/bin/x86_64-w64-mingw32-"
zlib="$stage/zlib-1.4"
source="$stage/ffmpeg-9.0.2"
jobs=${CLIP_FETCHER_BUILD_JOBS:-8}
export PATH="$toolchain/bin:/usr/bin:/bin:/usr/sbin:/sbin"

out="$stage/output"
licenses="$out/licenses"
mkdir -p "$out/bin" "$licenses/third-party/LLVM-MinGW" "$licenses/third-party/zlib"
cp "$source/COPYING.LGPLv2.1" "$source/LICENSE.md" "$ffmpeg_path" "$zlib_path" "$licenses/"
cp "$zlib/LICENSE" "$licenses/third-party/zlib/"
cp "$toolchain/LICENSE.TXT" "$licenses/third-party/LLVM-MinGW/LLVM-LICENSE.txt"
cp "$toolchain/x86_64-w64-mingw32/share/mingw32/"COPYING* "$licenses/third-party/LLVM-MinGW/"
cp "$script_dir/$(basename "$0")" "$licenses/rebuild.sh"

make -j "$jobs" -C "$zlib" -f win32/Makefile.gcc CC="${cross}clang" AR="$toolchain/bin/llvm-ar" libz.a

mkdir "$stage/build"
cd "$stage/build"
args=(
  --prefix=/ --arch=x86_64 --target-os=mingw32 --enable-cross-compile
  --cross-prefix="$cross" --cc="${cross}clang" --host-cc=/usr/bin/clang
  --ar="$toolchain/bin/llvm-ar" --nm="$toolchain/bin/llvm-nm" --ranlib="$toolchain/bin/llvm-ranlib"
  --strip="$toolchain/bin/llvm-strip" --windres="${cross}windres"
  --disable-autodetect --disable-shared --enable-static
  --disable-gpl --disable-version3 --disable-nonfree
  --disable-doc --disable-debug --disable-programs --enable-ffmpeg --enable-ffprobe
  --disable-avdevice --disable-devices --disable-x86asm
  --disable-encoders --enable-encoder=aac,wrapped_avframe,pcm_s16le,mjpeg,subrip,ass
  --disable-protocols --enable-protocol=file,pipe,http,tcp
  --enable-zlib --enable-w32threads --extra-cflags="-I$zlib" --extra-ldflags="-static -L$zlib"
)
"$source/configure" "${args[@]}"
make -j "$jobs" ffmpeg.exe ffprobe.exe

cp ffmpeg.exe ffprobe.exe "$out/bin/"
for executable in ffmpeg.exe ffprobe.exe; do
  pe_report="$licenses/$executable.pe.txt"
  "$toolchain/bin/llvm-readobj" --file-headers --coff-imports "$out/bin/$executable" > "$pe_report"
  if ! grep -q 'IMAGE_FILE_MACHINE_AMD64' "$pe_report"; then
    echo "Expected an x64 PE executable: $executable" >&2
    exit 1
  fi
  if grep -Eiq 'Name: (libgcc|libstdc|libc\+\+|libwinpthread|msys-|libav|libz|zlib|libbz|vcruntime|msvcp)' "$pe_report"; then
    echo "Unexpected dynamic runtime dependency: $executable" >&2
    exit 1
  fi
done

{
  printf 'make -C %q -f win32/Makefile.gcc CC=%q AR=%q libz.a\n' "$zlib" "${cross}clang" "$toolchain/bin/llvm-ar"
  printf '%q' "$source/configure"
  printf ' %q' "${args[@]}"
  printf '\nmake ffmpeg.exe ffprobe.exe\n'
} > "$licenses/configure-command.txt"
ffmpeg_binary_sha=$(/usr/bin/shasum -a 256 "$out/bin/ffmpeg.exe" | cut -d ' ' -f 1)
ffprobe_binary_sha=$(/usr/bin/shasum -a 256 "$out/bin/ffprobe.exe" | cut -d ' ' -f 1)
cat > "$licenses/build-config.json" <<JSON
{
  "version": "9.0.2",
  "sourceUrl": "https://ffmpeg.org/releases/$ffmpeg_archive",
  "sourceSha256": "$ffmpeg_sha",
  "sourceModified": false,
  "target": "win-x64",
  "license": "LGPL-2.1-or-later",
  "configureCommandFile": "configure-command.txt",
  "buildEnvironment": "macOS cross build, LLVM-MinGW UCRT, static zlib",
  "toolchainUrl": "https://github.com/mstorsjo/llvm-mingw/releases/download/20261104/$toolchain_archive",
  "toolchainSha256": "$toolchain_sha",
  "zlibSourceUrl": "https://zlib.net/$zlib_archive",
  "zlibSourceSha256": "$zlib_sha",
  "mediaRuntimeHashes": { "ffmpeg.exe": "$ffmpeg_binary_sha", "ffprobe.exe": "$ffprobe_binary_sha" }
}
JSON

mkdir -p "$(dirname "$prefix")"
mkdir "$prefix"
cp -R "$out/" "$prefix/"
echo "Cross-built Windows x64 FFmpeg ready: $prefix"
