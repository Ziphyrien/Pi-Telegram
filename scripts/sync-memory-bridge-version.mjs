import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootPackagePath = resolve('package.json');
const bridgePackagePath = resolve('packages', 'pi-memory-bridge', 'package.json');
const bridgeManifestPath = resolve('packages', 'pi-memory-bridge', 'bridge.manifest.json');

const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf-8'));
const bridgePackage = JSON.parse(readFileSync(bridgePackagePath, 'utf-8'));
const bridgeManifest = JSON.parse(readFileSync(bridgeManifestPath, 'utf-8'));

const version = String(rootPackage.version || '').trim();
if (!version) {
  throw new Error('root package.json missing version');
}

bridgePackage.version = version;
bridgeManifest.appVersion = version;
bridgeManifest.bridgeVersion = version;

writeFileSync(bridgePackagePath, `${JSON.stringify(bridgePackage, null, 2)}\n`, 'utf-8');
writeFileSync(bridgeManifestPath, `${JSON.stringify(bridgeManifest, null, 2)}\n`, 'utf-8');
