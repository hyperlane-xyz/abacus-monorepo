import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const RELEASE_DIR = join(process.cwd(), 'release');

try {
  if (existsSync(RELEASE_DIR)) {
    console.log(
      '[INFO] Contracts already present in src/release, skipping fetch',
    );
    process.exit(0);
  }

  console.log('[INFO] Fetching contracts...');
  execSync('./scripts/fetch-contracts-release.sh', {
    stdio: 'inherit',
    cwd: join(process.cwd()),
  });
} catch (error) {
  console.error('[ERROR]', (error as Error).message);
  process.exit(1);
}