import dotenv from 'dotenv';
import archiver from 'archiver';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Load from .env.production.local for deployment credentials + prod env vars.
// Required by the web target (yc_bucket_deploy.mjs reads the same file); the zip
// target only needs a built dist/, but loading here keeps prod env injected
// consistently for both paths.
dotenv.config({ path: '.env.production.local' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const validTargets = ['web', 'zip'];

function parseTargets() {
    const argv = process.argv.slice(2);
    let targets = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--targets' && i + 1 < argv.length) {
            targets = argv[i + 1];
            i++;
        } else if (argv[i].startsWith('--targets=')) {
            targets = argv[i].slice('--targets='.length);
        }
    }
    const list = (targets ?? 'web,zip')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    const invalid = list.filter((t) => !validTargets.includes(t));
    if (invalid.length) {
        console.error(`Error: Unknown target(s): ${invalid.join(', ')}. Valid targets: ${validTargets.join(', ')}.`);
        process.exit(1);
    }
    if (!list.length) {
        console.error('Error: No targets selected.');
        process.exit(1);
    }
    return list;
}

// Run a command in the chapaev dir, streaming stdio through. Rejects on non-zero exit.
function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', cwd: __dirname, shell: true });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`\`${cmd} ${args.join(' ')}\` exited with code ${code}`));
        });
        child.on('error', reject);
    });
}

// Zip the contents of dist/ so that index.html sits at the zip root
// (required by CrazyGames / Yandex Games portal uploads).
function zipDist(sourceDir, outFile) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        const output = fs.createWriteStream(outFile);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => resolve(archive.pointer()));
        archive.on('error', reject);
        archive.on('warning', (err) => {
            if (err.code !== 'ENOENT') reject(err);
        });
        archive.pipe(output);
        // `false` = flatten dist/ so its contents (index.html, assets/, ...) are at the zip root.
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

async function main() {
    const targets = parseTargets();
    const distDir = path.join(__dirname, 'dist');
    const zipOut = path.join(__dirname, 'dist-zip', 'chapaev.zip');

    console.log(`Release targets: ${targets.join(', ')}`);

    // 1. Ensure dist/ exists. The web target builds via yc_bucket_deploy.mjs;
    //    zip-only runs the build directly.
    if (targets.includes('web')) {
        console.log('\n=== [web] Building + uploading to Yandex Cloud bucket ===');
        await run('node', ['yc_bucket_deploy.mjs']);
    } else {
        console.log('\n=== Building project ===');
        await run('pnpm', ['build']);
    }

    if (!fs.existsSync(distDir)) {
        console.error('Error: dist/ not found after build.');
        process.exit(1);
    }

    // 2. Zip the same build for portal submissions.
    if (targets.includes('zip')) {
        console.log('\n=== [zip] Packaging dist/ into chapaev.zip ===');
        const bytes = await zipDist(distDir, zipOut);
        console.log(`Created ${path.relative(__dirname, zipOut)} (${(bytes / 1024).toFixed(1)} KB)`);
    }

    // 3. Summary
    console.log('\n=== Release summary ===');
    if (targets.includes('web')) {
        const bucket = process.env.BUCKET_NAME;
        console.log(`web: uploaded to ${bucket ? `https://${bucket}` : '(BUCKET_NAME not set)'}`);
    }
    if (targets.includes('zip')) {
        console.log(`zip: ${path.relative(__dirname, zipOut)}`);
        console.log('     Upload manually to the CrazyGames dashboard and the Yandex Games console');
        console.log('     (https://games.yandex.ru) — these portals have no public upload API.');
    }
    console.log('');
}

main().catch((err) => {
    console.error('Release failed:', err.message);
    process.exit(1);
});
