#!/usr/bin/env bash
set -euo pipefail
# Run inside the MSYS2 UCRT64 shell with GCC, make, curl, tar and xz installed.
# The Windows workflow supplies those build tools. No prebuilt GPL media binary
# is fetched or redistributed.
if [[ "${MSYSTEM:-}" != "UCRT64" ]]; then
  echo "Run this script in the MSYS2 UCRT64 shell." >&2
  exit 1
fi
project_dir=$(cd "$(dirname "$0")/.." && pwd)
build_dir=${CLIP_FETCHER_BUILD_DIR:-"$project_dir/../../work/desktop-build"}
build_dir=$(cygpath -u "$build_dir")
version=9.0.2
archive="ffmpeg-$version.tar.xz"
checksum=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
prefix="$build_dir/ffmpeg/win-x64"
mkdir -p "$build_dir/downloads" "$build_dir/ffmpeg-source" "$build_dir/ffmpeg-build/win-x64"
if [[ ! -f "$build_dir/downloads/$archive" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 "https://ffmpeg.org/releases/$archive" -o "$build_dir/downloads/$archive.download"
  mv "$build_dir/downloads/$archive.download" "$build_dir/downloads/$archive"
fi
printf '%s  %s\n' "$checksum" "$build_dir/downloads/$archive" | sha256sum --check --status
if [[ ! -f "$build_dir/ffmpeg-source/ffmpeg-$version/configure" ]]; then
  tar -xf "$build_dir/downloads/$archive" -C "$build_dir/ffmpeg-source"
fi
source_dir="$build_dir/ffmpeg-source/ffmpeg-$version"
cd "$build_dir/ffmpeg-build/win-x64"
args=(
  --prefix=/ --arch=x86_64 --target-os=mingw32 --cc=gcc
  --disable-autodetect --disable-shared --enable-static
  --disable-gpl --disable-version3 --disable-nonfree
  --disable-doc --disable-debug --disable-programs --enable-ffmpeg --enable-ffprobe
  --disable-avdevice --disable-devices --disable-x86asm
  --disable-encoders --enable-encoder=aac,wrapped_avframe,pcm_s16le,mjpeg,subrip,ass
  --disable-protocols --enable-protocol=file,pipe,http,tcp
  --enable-zlib --enable-w32threads --extra-ldflags=-static
)
"$source_dir/configure" "${args[@]}"
make -j "${CLIP_FETCHER_BUILD_JOBS:-4}"
make install DESTDIR="$prefix"
mkdir -p "$prefix/licenses"
cp "$source_dir/COPYING.LGPLv2.1" "$source_dir/LICENSE.md" "$prefix/licenses/"
cp "$build_dir/downloads/$archive" "$prefix/licenses/"
if [[ ! -d /ucrt64/share/licenses ]]; then
  echo "The MinGW toolchain license directory is missing." >&2
  exit 1
fi
cp -R /ucrt64/share/licenses "$prefix/licenses/third-party"
printf './configure' > "$prefix/licenses/configure-command.txt"
printf ' %q' "${args[@]}" >> "$prefix/licenses/configure-command.txt"
printf '\nmake -j4\nmake install DESTDIR="$PWD/output"\n' >> "$prefix/licenses/configure-command.txt"
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\n'
  printf 'tar -xf %q\ncd ffmpeg-%s\n' "$archive" "$version"
  cat "$prefix/licenses/configure-command.txt"
} > "$prefix/licenses/rebuild.sh"
cat > "$prefix/licenses/build-config.json" <<'JSON'
{
  "version": "9.0.2",
  "sourceUrl": "https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz",
  "sourceSha256": "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
  "sourceModified": false,
  "target": "win-x64",
  "license": "LGPL-2.1-or-later",
  "configureCommandFile": "configure-command.txt",
  "buildEnvironment": "MSYS2 UCRT64, GCC, make; static media libraries and compiler runtime"
}
JSON
# mingw system DLLs are allowed; GCC/MSYS/codec DLLs are not bundled assumptions.
for executable in "$prefix/bin/ffmpeg.exe" "$prefix/bin/ffprobe.exe"; do
  if objdump -p "$executable" | sed -n 's/.*DLL Name: //p' | grep -Eqi '(libgcc|libstdc|libwinpthread|msys-|libav|libz|libbz)'; then
    echo "Unexpected non-system DLL dependency in $executable" >&2
    exit 1
  fi
done
echo "FFmpeg ready: $prefix"
