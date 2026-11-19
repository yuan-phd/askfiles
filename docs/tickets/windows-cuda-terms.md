# Ticket: the NVIDIA terms for the CUDA files of the Windows build

Status: resolved for the current use (owner decision 2026-11-19, branch local/release-compliance): the files stay bundled. The current use is a non-commercial portfolio app shared with friends as Mac and Windows builds (docs/plan.md, License and release items). **Reopen this ticket if the use becomes commercial or wide** (public distribution, a store, a company using it), or when the CUDA version changes. Not legal advice.

Raised with local/license-notices (owner decision 2026-11-18), when it blocked the first regular Windows release.

## The files

The Windows build ships three NVIDIA files from the Ollama release, in resources/ollama/lib/ollama/cuda_v12 (docs/licenses.md, Windows build):

- cudart64_12.dll, CUDA Runtime 12.8.57
- cublas64_12.dll, cuBLAS 12.8.3
- cublasLt64_12.dll, cuBLASLt 12.8.3

They are proprietary and redistributed under the NVIDIA CUDA Toolkit End User License Agreement (https://docs.nvidia.com/cuda/eula/index.html, v13.5, last updated January 26, 2026, read again on 2026-11-19; the CUDA 12.8 version is at https://docs.nvidia.com/cuda/archive/12.8.0/eula/index.html and has the same sections 1.1, 1.2 and 2.6). scripts/lib/windows-runtimes.mjs fails the notices step on a cudart version other than 12.8.57.

## Each NVIDIA condition and how it is met

Quotes are from the EULA, v13.5.

| Condition | How AskFiles meets it |
| --- | --- |
| 1.1.1 grant: "Distribute those portions of the SDK that are identified in this Agreement as distributable, as incorporated in object code format into a software application that meets the distribution requirements indicated in this Agreement." | The three files are listed in Attachment A (below, with the file-name risk). They ship unmodified, in object code, inside AskFiles. |
| 1.1.2 item 1: "Your application must have material additional functionality, beyond the included portions of the SDK." | AskFiles is a document question-and-answer app; the files only speed up its local model on an NVIDIA GPU. |
| 1.1.2 item 2: "The distributable portions of the SDK shall only be accessed by your application." | They sit in Ollama's runtime folder inside the AskFiles install and are loaded only by the bundled Ollama that AskFiles starts. The installer's terms say they may be used only as part of AskFiles (build/license.txt, part 2). |
| 1.1.2 item 3: the notice "This software contains source code provided by NVIDIA Corporation." for modifications and derivative works of sample source code. | Not applicable: no NVIDIA sample source code is shipped or modified. |
| 1.1.2 item 4: developer tools are for internal use unless identified as distributable. | No developer tool is shipped: only the three runtime libraries. |
| 1.1.2 item 5: "The terms under which you distribute your application must be consistent with the terms of this Agreement, including (without limitation) terms relating to the license grant and license restrictions and protection of NVIDIA's intellectual property rights. Additionally, you agree that you will protect the privacy, security and legal rights of your application users." | The Windows installer shows a license page the user must accept (I Agree) before installing. Its part 2 states that the files are NVIDIA's, proprietary, not covered by the Apache License or any open source license, and binds the user to the EULA's restrictions: use only as part of AskFiles, no reverse engineering or removal of notices, no circumvention, no use that would subject them to an open source license, no Critical Applications, no warranty. THIRD-PARTY-NOTICES says the same. Users' privacy: AskFiles keeps documents and questions on the machine (docs/plan.md, Goal and scope). |
| 1.1.2 item 6: "You agree to notify NVIDIA in writing of any known or suspected distribution or use of the SDK not in compliance with the requirements of this Agreement, and to enforce the terms of your agreements with respect to distributed SDK." | An obligation of the author, not of the package. None is known. |
| 1.2 item 1: no reverse engineering, and no removing "copyright or other proprietary notices from any portion of the SDK". | The files ship byte for byte as in the Ollama release; the installer's terms forbid reverse engineering them. |
| 1.2 item 2: "you may not distribute or sublicense the SDK as a stand-alone product." | They ship only inside AskFiles; the installer's terms forbid distributing them on their own. |
| 1.2 item 3: no indication that the application is sponsored or endorsed by NVIDIA. | AskFiles makes no such claim. |
| 1.2 item 4: no bypassing encryption, security, DRM or authentication. | Not done; forbidden to users by the installer's terms. |
| 1.2 item 5: "You may not use the SDK in any manner that would cause it to become subject to an open source software license." | AskFiles' Apache License covers only AskFiles' own code; the installer page and THIRD-PARTY-NOTICES both say the NVIDIA files are not covered by it or by any other open source license. Ollama's MIT license covers Ollama's own code, not these files. **Uncertain** (see below). |
| 1.2 items 6 and 7: not for Critical Applications; indemnity for such use. | The installer's terms forbid such use. AskFiles is not built or offered for it. |
| 2.1: "The SDK is licensed for you to develop applications only for use in systems with NVIDIA GPUs." | Ollama runs models on the CUDA runtime only when it finds an NVIDIA GPU; on other computers its CUDA backend fails to load (no NVIDIA driver) and it runs on the CPU. The installer's terms limit use to computers with an NVIDIA graphics card. |
| 2.6 Attachment A lists the distributable files. | See the accepted risk below. |

## Accepted risk: the _12 file names

Attachment A (section 2.6) lists "cudart.dll" (CUDA Runtime) and "cublas.dll, cublasLt.dll" (CUDA BLAS Library) for Windows, and says "The following CUDA Toolkit files may be distributed with applications developed by you, including certain variations of these files that have version number or architecture specific information embedded in the file name - as an example only, for release version 9.0 of the 64-bit Windows software, the file cudart64_90.dll is redistributable." The shipped names cudart64_12.dll, cublas64_12.dll and cublasLt64_12.dll are not listed by name; that they are such variations (64 for the architecture, 12 for the major version, as in the example) is a reading of that clause, not a confirmation from NVIDIA or a lawyer.

The owner accepts this risk for the current, non-commercial use (2026-11-19). The same reading underlies the Ollama release itself, which ships these files.

Likewise uncertain, and accepted with it: whether shipping the files inside Ollama (MIT) in an Apache-2.0 application, with the statements above, is enough for 1.1.2 item 5 and 1.2 item 5.

## When this is reopened

If the use becomes commercial or wide, one of:

A. **Legal confirmation.** A lawyer who practises software licensing confirms the file names and the distribution terms, in writing, for the versions shipped; record the answer and its date in docs/licenses.md (Windows build). Or ask NVIDIA (section 2.5: nvidia-compute-license-questions@nvidia.com).

B. **Stop bundling them.** Remove cuda_v12 from the Windows package: OLLAMA_WINDOWS_KEEP in .github/workflows/windows.yml, which scripts/lib/ollama-runtimes.mjs reads. Its --keep option needs a change to accept keeping no GPU runtime (today an empty value stops it with its usage message). Consequences, to measure before choosing:
   - Ollama on Windows runs on the CPU only, unless the vulkan runtime is kept instead (ggml-vulkan.dll, 43 MB, built by Ollama; the Vulkan driver comes with the GPU driver). Its speed and stability against CUDA are unmeasured.
   - The unpacked app shrinks by about 1.1 GB (cuda_v12) and the installer with it, which also removes the NSIS 2 GB concern (docs/windows.md).
   - THIRD-PARTY-NOTICES drops the CUDA group by itself; ggml-cuda.dll goes with the folder.
   - A third way, relying on a CUDA runtime the user installs, or downloading it at first run, was not examined.
