// The public package matrix is deliberately smaller than Node's target matrix.
// Reject unsupported requests before a builder downloads or replaces anything.
export function releaseArchitecture(platform, args = []) {
  const supported = { darwin: 'arm64', win32: 'x64' };
  if (!Object.hasOwn(supported, platform)) throw new Error('No release is configured for this platform.');
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')
      || !(args.length === 0 || args.length === 2 && args[0] === '--arch')) {
    throw new Error('Use only --arch arm64 for Mac or --arch x64 for Windows.');
  }
  const arch = args.length ? args[1] : supported[platform];
  if (arch !== supported[platform]) {
    throw new Error(platform === 'darwin'
      ? 'Mac releases support arm64 only. Intel Mac packages are not offered.'
      : 'Windows releases support x64 only. ARM64 and 32-bit packages are not offered.');
  }
  return arch;
}
