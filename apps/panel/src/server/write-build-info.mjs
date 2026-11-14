import { readFileSync, writeFileSync } from 'node:fs';

const [packagePath, outputPath] = process.argv.slice(2);
if (!packagePath || !outputPath) throw new Error('Package and output paths are required');
const version = process.env.SERVUS_BUILD_VERSION || 'unknown';
const revision = process.env.SERVUS_BUILD_REVISION || 'unknown';
const packageVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version;
if (version === 'unknown' && revision === 'unknown') {
  // Local builds do not claim a source identity.
} else if (version !== packageVersion || !/^[0-9a-f]{40}$/.test(revision)) {
  throw new Error('Build version must match the panel package and revision must be a full lowercase Git SHA');
}
writeFileSync(outputPath, `export const BUILD_INFO = Object.freeze(${JSON.stringify({ version, revision })});\n`);
