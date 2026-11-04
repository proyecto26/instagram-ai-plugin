// Preloaded before every unit test (see bunfig.toml): no pacing delays, and an
// isolated data dir so tests never touch the real session.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Live tests (INSTAGRAM_LIVE=1) need the real session and real pacing: leave them alone.
if (process.env.INSTAGRAM_LIVE !== '1') {
    process.env.INSTAGRAM_MIN_GAP_MS = '0';
    process.env.INSTAGRAM_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'ig-test-'));
    delete process.env.INSTAGRAM_COOKIES;
}
