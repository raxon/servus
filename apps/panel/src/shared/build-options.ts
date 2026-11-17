/** Generated files are confined to a normal, relative path inside the build context. */
export function validEnvFilePath(value: string): boolean {
  if (!value || value.length > 255 || /[\\\x00-\x1f\x7f:]/.test(value) || value.startsWith('/')) return false;
  return value.split('/').every(segment => Boolean(segment) && segment !== '.' && segment !== '..'
    && !['.git', '.dockerignore', 'dockerfile'].includes(segment.toLowerCase()));
}
