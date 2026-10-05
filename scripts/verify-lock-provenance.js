'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || process.cwd());
const packageDirs = ['api-service', 'transaction-core'];
const approvedRegistry = 'https://registry.npmjs.org';
const dependencyClasses = ['dependencies', 'devDependencies', 'optionalDependencies'];
const errors = [];

for (const packageDir of packageDirs) {
  const manifestPath = path.join(root, packageDir, 'package.json');
  const lockPath = path.join(root, packageDir, 'package-lock.json');

  if (!fs.existsSync(manifestPath)) {
    errors.push(packageDir + ': package.json missing');
    continue;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (!fs.existsSync(lockPath)) {
    errors.push(packageDir + ': package-lock.json missing');
    continue;
  }

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    errors.push(packageDir + ': invalid package-lock.json');
    continue;
  }

  if (lock.lockfileVersion !== 3) {
    errors.push(packageDir + ': lockfileVersion must be 3');
  }

  const lockRoot = lock.packages && lock.packages[''];
  if (!lockRoot) {
    errors.push(packageDir + ': lock root entry missing');
    continue;
  }

  if (lockRoot.name !== manifest.name) errors.push(packageDir + ': package name drift');
  if (lockRoot.version !== manifest.version) errors.push(packageDir + ': package version drift');

  for (const dependencyClass of dependencyClasses) {
    const declared = manifest[dependencyClass] || {};
    const locked = lockRoot[dependencyClass] || {};

    for (const [dependency, version] of Object.entries(declared)) {
      if (locked[dependency] !== version) {
        errors.push(packageDir + ': ' + dependencyClass + '.' + dependency + ' drift');
      }
    }

    for (const dependency of Object.keys(locked)) {
      if (!(dependency in declared)) {
        errors.push(packageDir + ': stale ' + dependencyClass + '.' + dependency);
      }
    }
  }

  for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
    if (!packagePath || !metadata.resolved) continue;

    const resolved = String(metadata.resolved);
    if (/^(file:|link:|git:|git\+|github:)/i.test(resolved)) {
      errors.push(packageDir + ': forbidden dependency source ' + packagePath);
      continue;
    }

    let url;
    try {
      url = new URL(resolved);
    } catch {
      errors.push(packageDir + ': malformed resolved URL ' + packagePath);
      continue;
    }

    if (url.protocol !== 'https:') {
      errors.push(packageDir + ': non-HTTPS dependency source ' + packagePath);
    }

    if (url.origin !== approvedRegistry) {
      errors.push(packageDir + ': unapproved registry ' + url.origin);
    }

    if (!metadata.integrity) {
      errors.push(packageDir + ': missing integrity ' + packagePath);
    }
  }
}

if (errors.length) {
  console.error('FlowDesk dependency provenance gate FAILED');
  console.error(errors.map((error) => ' - ' + error).join('\n'));
  process.exit(1);
}

console.log('FlowDesk dependency provenance gate passed');
