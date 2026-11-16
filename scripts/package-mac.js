const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const release = process.argv.includes('--release');
const preview = process.argv.includes('--preview');
const output = path.join(root, 'dist', release ? 'release' : preview ? 'preview' : '');
const filename = 'Anotch-Mac-Apple-Silicon.dmg';
const codesign = '/usr/bin/codesign';
const xcrun = '/usr/bin/xcrun';
let staging;

function checked(command, args, message, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(message);
  return result;
}

function signingIdentity() {
  const list = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error('Could not look up macOS code signing identities.');
  const allowed = release ? /^Developer ID Application:/ : /^(Apple Development|Mac Developer|Developer ID Application):/;
  const identities = [...list.stdout.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"/gm)]
    .filter((entry) => allowed.test(entry[2]));
  const identityType = release ? 'Developer ID Application' : 'Apple Development or Developer ID Application';
  if (!identities.length) throw new Error(`Install a valid ${identityType} signing identity in the Keychain.`);
  const specified = process.env.ANOTCH_SIGN_IDENTITY?.trim();
  if (release && !specified) {
    throw new Error('Set ANOTCH_SIGN_IDENTITY to the exact Developer ID Application name or fingerprint for this release.');
  }
  if (!specified && identities.length > 1) {
    throw new Error('Set ANOTCH_SIGN_IDENTITY to the exact name or fingerprint of the intended signing identity.');
  }
  const match = specified
    ? identities.find((entry) => entry[1].toLowerCase() === specified.toLowerCase() || entry[2] === specified)
    : identities[0];
  if (!match) throw new Error(`ANOTCH_SIGN_IDENTITY must select a valid ${identityType} signing identity.`);
  return { hash: match[1], development: !match[2].startsWith('Developer ID Application:') };
}

function notaryAuthArgs() {
  const profile = process.env.ANOTCH_NOTARY_PROFILE?.trim();
  if (!profile) throw new Error('Set ANOTCH_NOTARY_PROFILE to the name of a notarytool Keychain profile.');
  const keychain = process.env.ANOTCH_NOTARY_KEYCHAIN?.trim();
  const args = ['--keychain-profile', profile];
  if (keychain) args.push('--keychain', path.resolve(root, keychain));
  checked(xcrun, ['notarytool', 'history', ...args, '--output-format', 'json'],
    'Apple notary authentication failed. Check ANOTCH_NOTARY_PROFILE and the Keychain where it was saved.',
    { stdio: 'pipe', timeout: 45_000 });
  return args;
}

function signatureDetails(file) {
  return checked(codesign, ['-d', '--verbose=4', file], 'Could not read the macOS code signature.',
    { stdio: 'pipe', encoding: 'utf8' }).stderr;
}

function verifyDistributionSignature(signature, item) {
  if (!/^Authority=Developer ID Application:/m.test(signature) || !/^Timestamp=/m.test(signature)) {
    throw new Error(`${item} must be signed with Developer ID Application and a secure timestamp.`);
  }
}

function notarizeDMG(installer, authArgs) {
  console.log('Submitting the signed DMG to Apple for notarization.');
  const result = spawnSync(xcrun, ['notarytool', 'submit', installer, ...authArgs,
    '--wait', '--output-format', 'json'], { encoding: 'utf8' });
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { /* The tool can fail before returning a receipt. */ }
  if (result.status !== 0 || receipt?.status !== 'Accepted') {
    const id = /^[a-f0-9-]{36}$/i.test(receipt?.id ?? '') ? ` Submission ${receipt.id}.` : '';
    throw new Error(`Apple did not accept the DMG for notarization.${id}`);
  }
  console.log(`Apple accepted notarization submission ${receipt.id}.`);
  checked(xcrun, ['stapler', 'staple', installer], 'Could not staple the notarization ticket to the DMG.');
  checked(xcrun, ['stapler', 'validate', installer], 'The DMG notarization ticket could not be validated.');
}

try {
  if (release && preview) throw new Error('Choose either --release or --preview.');
  const identity = preview ? { hash: '-', development: false } : signingIdentity();
  const authArgs = release ? notaryAuthArgs() : undefined;
  if (release || preview) {
    checked('npm', ['run', 'check'], 'Anotch source checks failed.');
    checked('npm', ['run', 'build:native'], 'Anotch native helpers did not build.');
  }
  staging = fs.mkdtempSync(path.join(os.tmpdir(), 'anotch-build-'));
  let signingOptions = [];
  const env = { ...process.env };
  if (preview) {
    delete env.CSC_LINK;
    delete env.CSC_KEYCHAIN;
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    signingOptions = ['--config.mac.type=distribution', '--config.mac.timestamp=none', '--config.dmg.sign=false'];
  } else if (release) {
    signingOptions = [
      '--config.mac.type=distribution', '--config.mac.hardenedRuntime=true',
      '--config.mac.entitlements=config/entitlements.mac.plist',
      '--config.mac.entitlementsInherit=config/entitlements.mac.plist'
    ];
  } else if (identity.development) {
    signingOptions = ['--config.mac.type=development', '--config.mac.timestamp=none'];
  }
  checked(process.execPath, [
    require.resolve('electron-builder/cli'), '--config', 'config/macos.json', '--mac', '--arm64', '--publish', 'never',
    '--config.directories.output=' + staging,
    '--config.mac.identity=' + identity.hash,
    ...signingOptions
  ], 'The macOS package did not finish building.', { env });
  const bundle = path.join(staging, 'mac-arm64', 'Anotch.app');
  checked(codesign, ['--verify', '--deep', '--strict', bundle], 'The app bundle did not pass code signature verification.');
  const signature = signatureDetails(bundle);
  if (preview) {
    if (!/^Signature=adhoc$/m.test(signature) || !/^TeamIdentifier=not set$/m.test(signature) || /^Authority=/m.test(signature)) {
      throw new Error('The preview must use an ad hoc signature with no signing certificate or team ID.');
    }
  } else if (!/^TeamIdentifier=[A-Z0-9]{10}$/m.test(signature)) {
    throw new Error('The app does not have a valid team signature.');
  }
  const installer = path.join(staging, filename);
  if (release) {
    verifyDistributionSignature(signature, 'The app');
    if (!/^CodeDirectory .*flags=0x[\da-f]+\([^)]*\bruntime\b/m.test(signature)) {
      throw new Error('The app must enable Hardened Runtime before notarization.');
    }
    checked(codesign, ['--sign', identity.hash, '--timestamp', installer], 'Could not sign the disk image.');
    verifyDistributionSignature(signatureDetails(installer), 'The disk image');
    notarizeDMG(installer, authArgs);
    checked(codesign, ['--verify', '--strict', installer], 'The notarized disk image did not pass signature verification.');
    checked('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', installer],
      'The notarized disk image did not pass Gatekeeper assessment.');
  }
  fs.mkdirSync(output, { recursive: true });
  const candidate = path.join(output, `.${path.basename(staging)}-${filename}`);
  try {
    fs.copyFileSync(installer, candidate);
    fs.renameSync(candidate, path.join(output, filename));
  } finally { fs.rmSync(candidate, { force: true }); }
  console.log('Installer: ' + path.join(output, filename));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (staging) fs.rmSync(staging, { recursive: true, force: true });
}
