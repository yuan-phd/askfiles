# Ticket: confirm the NVIDIA terms for the CUDA files of the Windows build, or stop bundling them

Status: open. Raised with local/license-notices (owner decision 2026-11-18). Blocks the first regular Windows release; test builds may go on. Not legal advice.

## Why

The Windows build ships three NVIDIA files from the Ollama release, in resources/ollama/lib/ollama/cuda_v12 (docs/licenses.md, Windows build):

- cudart64_12.dll, CUDA Runtime 12.8.57
- cublas64_12.dll, cuBLAS 12.8.3
- cublasLt64_12.dll, cuBLASLt 12.8.3

They are proprietary and redistributed under the NVIDIA CUDA Toolkit End User License Agreement (https://docs.nvidia.com/cuda/eula/index.html; the CUDA 12.8 version is at https://docs.nvidia.com/cuda/archive/12.8.0/eula/index.html). THIRD-PARTY-NOTICES names them with their versions and the EULA's conditions and says they are not covered by AskFiles' Apache License. The EULA asks for no notice text for them. Two points could not be settled from the text:

1. **UNCERTAIN: are these file names covered by Attachment A?** Section 2.6 lists "cudart.dll" (CUDA Runtime) and "cublas.dll, cublasLt.dll" (CUDA BLAS Library) for Windows, "including certain variations of these files that have version number or architecture specific information" (its example: cudart64_90.dll). The shipped names cudart64_12.dll, cublas64_12.dll and cublasLt64_12.dll are not listed; that they are such variations is a reading of that clause.
2. **UNCERTAIN: are the distribution terms consistent with the EULA?** Section 1.1.2 item 5 requires that the terms under which the application is distributed be consistent with the agreement, and section 1.2 item 5 forbids using the SDK in a way that would make it subject to an open source license. The files ship inside Ollama (MIT) in an application whose own code is under Apache-2.0. THIRD-PARTY-NOTICES says the Apache License does not cover them; whether that is enough is for a lawyer.

docs/plan.md, Before formal release, already lists the legal check; this ticket makes it a release gate with a fallback.

## Options

A. **Legal confirmation.** A lawyer who practises software licensing confirms both points, in writing, for the versions shipped. Record the answer and its date in docs/licenses.md (Windows build) and close the ticket. Repeat when the CUDA version changes: scripts/lib/windows-runtimes.mjs already fails the notices step on a cudart version other than 12.8.57.

B. **Stop bundling them.** Remove cuda_v12 from the Windows package: OLLAMA_WINDOWS_KEEP in .github/workflows/windows.yml, which scripts/lib/ollama-runtimes.mjs reads. Its --keep option needs a change to accept keeping no GPU runtime (today an empty value stops it with its usage message). Consequences, to measure before choosing:
   - Ollama on Windows runs on the CPU only, unless the vulkan runtime is kept instead (ggml-vulkan.dll, 43 MB, built by Ollama; the Vulkan driver comes with the GPU driver). Its speed and stability against CUDA are unmeasured.
   - The unpacked app shrinks by about 1.1 GB (cuda_v12) and the installer with it, which also removes the NSIS 2 GB concern (docs/windows.md).
   - THIRD-PARTY-NOTICES drops the CUDA group by itself; ggml-cuda.dll goes with the folder.
   - A third way, relying on a CUDA runtime the user installs, or downloading it at first run, was not examined.

## Acceptance

- Before the first regular Windows release, one of: a written legal confirmation of points 1 and 2, recorded in docs/licenses.md; or a Windows package without cudart64_12.dll, cublas64_12.dll and cublasLt64_12.dll, checked in the package's THIRD-PARTY-NOTICES (no CUDA group) and by the Windows smoke test answering a question.
- docs/plan.md, Before formal release, points to the outcome.
