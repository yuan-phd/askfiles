#!/usr/bin/env node
// Writes build/license.txt, the text of the Windows installer's license page (electron-builder.yml,
// nsis.license). The user must click I Agree to install. It carries the terms end users have to
// accept for what the Windows package redistributes (docs/licenses.md, Windows installer license
// page):
// - AskFiles' own Apache License 2.0 (LICENSE, NOTICE);
// - terms for the NVIDIA CUDA files that are consistent with the NVIDIA CUDA Toolkit EULA, section
//   1.1.2 item 5 (docs/tickets/windows-cuda-terms.md);
// - the Microsoft Visual C++ runtime license terms, so end users agree to terms that protect the
//   runtime at least as much as the Visual Studio 2022 terms ask (Distributable Code);
// - one line that AskFiles may be passed on only unmodified and with these terms, so anyone who
//   passes the installer on has accepted terms too.
// scripts/installer-license.test.mjs fails when the committed file differs from what this writes.
//
// Usage: node scripts/installer-license.mjs [out-file]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALLER_LICENSE = path.join(ROOT, 'build', 'license.txt');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').trimEnd();

const RULE = '='.repeat(72);

export function installerLicenseText() {
  return [
    'ASKFILES LICENSE TERMS',
    '',
    'Please read these terms. Click I Agree to install AskFiles; click Cancel if you do not agree.',
    '',
    'By installing AskFiles you accept:',
    '1. The Apache License 2.0, under which AskFiles is licensed (part 1).',
    '2. The terms for the NVIDIA CUDA files AskFiles includes (part 2).',
    '3. The Microsoft license terms for the Visual C++ runtime files AskFiles includes (part 3).',
    '',
    'AskFiles also includes open source software from others under their own licenses. All of them,',
    'with their license texts and where to get the source code of the LGPL libraries, are in',
    'THIRD-PARTY-NOTICES, which the About page of AskFiles opens.',
    '',
    'AskFiles may be passed on only unmodified and together with these terms.',
    '',
    RULE,
    'PART 1. ASKFILES: APACHE LICENSE 2.0',
    RULE,
    '',
    read('NOTICE'),
    '',
    read('LICENSE'),
    '',
    RULE,
    'PART 2. NVIDIA CUDA FILES',
    RULE,
    '',
    'AskFiles includes cudart64_12.dll, cublas64_12.dll and cublasLt64_12.dll (NVIDIA CUDA Runtime and',
    'cuBLAS, in resources\\ollama\\lib\\ollama\\cuda_v12), which let it use an NVIDIA graphics card.',
    'They are the property of NVIDIA Corporation and its licensors. They are proprietary software, not',
    'covered by the Apache License in part 1 or by any other open source license. NVIDIA distributes',
    'them under the NVIDIA CUDA Toolkit End User License Agreement',
    '(https://docs.nvidia.com/cuda/eula/index.html), and AskFiles includes them under that agreement.',
    'For these files you agree that:',
    '- You use them only as part of AskFiles, which uses them only on computers with an NVIDIA',
    '  graphics card. You do not use them apart from AskFiles and do not distribute them on their own.',
    '- You do not reverse engineer, decompile or disassemble them, remove any copyright or other',
    '  proprietary notice from them, or bypass, disable or circumvent any encryption, security,',
    '  digital rights management or authentication mechanism in them.',
    '- You do not use them in any way that would make them subject to an open source software license.',
    '- They are not tested or certified for any system whose use or failure could threaten human life',
    '  or cause catastrophic damage (for example avionics, navigation, autonomous vehicles, military,',
    '  medical or life support systems), and you do not use them in such a system.',
    '- NVIDIA and its licensors keep all rights in them not expressly granted here. They are provided',
    '  "AS IS", without any warranty from NVIDIA or from the author of AskFiles; to the extent the law',
    '  allows, neither NVIDIA nor the author of AskFiles is liable for any damages arising from them.',
    '',
    RULE,
    'PART 3. MICROSOFT VISUAL C++ RUNTIME FILES',
    RULE,
    '',
    'AskFiles includes the Microsoft Visual C++ 2015 - 2022 runtime (msvcp140.dll, vcruntime140.dll and',
    'the other files THIRD-PARTY-NOTICES lists, in resources\\ollama\\lib\\ollama\\cuda_v12). Microsoft',
    'licenses them under the terms below, and you accept these terms for those files:',
    '',
    read('scripts/notices/msvc-runtime-LICENSE.txt'),
    '',
  ].join('\n');
}

/** UTF-8 with a byte order mark and Windows line ends: the license page reads the file as is. */
export function installerLicenseBytes() {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(installerLicenseText().replace(/\n/g, '\r\n'))]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? INSTALLER_LICENSE);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, installerLicenseBytes());
  console.log(`[installer-license] wrote ${path.relative(ROOT, out)}: ${fs.statSync(out).size} bytes`);
}
