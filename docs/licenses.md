# Licenses

## This repository

AskFiles' own code (everything outside upstream/: the Electron shell, the pages, the scripts, the patches, the configuration and the documentation) is Copyright (C) 2026 yuan-phd and licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only): LICENSE at the repository root holds the official text from gnu.org, and NOTICE the copyright line. The AnythingLLM core in upstream/ (git subtree, UPSTREAM_VERSION) stays under its own MIT License, Copyright (c) Mintplex Labs Inc., in upstream/LICENSE, which ships in the app as Resources/licenses/anything-llm-LICENSE and in THIRD-PARTY-NOTICES. Every other bundled component keeps its own license, listed below and in THIRD-PARTY-NOTICES. The About page shows the app's license, with its text, and the notices.

## How this file is made

Everything below the marker line, after the hand-written sections, is the output of `node scripts/license-report.mjs release/mac-arm64/AskFiles.app/Contents/Resources`, run against the packaged mac app (`npm run package:mac`), plus the shell's own dependency tree. The mac workflow fails when that output differs from this file, and when the committed THIRD-PARTY-NOTICES differs from the one the package build regenerates (docs/packaging.md, Third-party notices). The sections above the marker are written by hand. The Windows package holds the win32 builds of the platform packages instead of the darwin ones.

## Ollama, models and OCR data

None of the models is inside the DMG: the first-run wizard has Ollama pull them from the Ollama registry or from Hugging Face. The licenses were read on 2026-11-10 from the license layer of each model in Ollama (`ollama show <model> --license`) and from the model cards on huggingface.co.

| Component | Where it comes from | License |
| --- | --- | --- |
| Ollama v0.40.4 | Bundled in the app resources, folder ollama (docs/packaging.md step 2) | MIT, Copyright (c) Ollama (github.com/ollama/ollama, LICENSE at tag v0.40.4). The release archive does not hold this file, so THIRD-PARTY-NOTICES carries it (copy in scripts/notices/ollama-LICENSE). The archive does ship the license and notice files of llama.cpp, ggml, MLX, the Go toolchain and others; they stay in the bundle. |
| qwen3:14b-q4_K_M | Chat model of the 32 GB tier, from the Ollama library (config/presets.json) | Apache-2.0 (the model's license layer; Qwen/Qwen3-14B on Hugging Face is tagged apache-2.0) |
| Qwen3-14B-Q3_K_M.gguf, hf.co/unsloth/Qwen3-14B-GGUF | Chat model of the 16 GB tier, pinned by sha256 (config/presets.json chatModelFile) | Apache-2.0 per the repository's Hugging Face license tag. The repository has no LICENSE file and its readme states no other terms; Ollama shows no license layer for it. A quantization of Qwen3-14B, which is Apache-2.0. |
| (none) | The 8 GB tier has no chat model | |
| bge-m3:567m | Embedder of every tier | MIT (the license layer is the MIT template without a filled-in copyright line; BAAI/bge-m3 on Hugging Face is tagged mit) |
| qwen3:0.6b, all-minilm | Test models of the cloud environment and CI smoke test only, never shipped | Apache-2.0 |
| Tesseract language data, eng and chi_sim, 4.0.0_best_int | npm packages @tesseract.js-data/eng and @tesseract.js-data/chi_sim 1.0.0, shipped in app.asar and copied to the data directory at first run | The npm packages are MIT; the traineddata files come from tesseract-ocr/tessdata_best, Apache-2.0 |

None of these licenses restricts how the models' output may be used.

## Windows build: runtime files from the Ollama release

Read on 2026-11-10 from ollama-windows-amd64.zip v0.40.4 (the archive the Windows workflow downloads, docs/windows.md), after scripts/lib/ollama-runtimes.mjs keeps only cuda_v12. The Ollama archive ships license files for llama.cpp, ggml and the libraries built into them, but none for the Microsoft, LLVM and MinGW-w64 runtimes below; AskFiles adds those texts. When `npm run notices -- --strict` runs on the Windows package (`npm run package:win`, with the Ollama package in resources/ollama), scripts/lib/windows-runtimes.mjs puts every .dll and .exe of the Ollama folder into one of these groups, writes the section "Windows: runtime libraries in the Ollama folder" and the texts into THIRD-PARTY-NOTICES, and fails on a file in no group or on a runtime version other than the one the texts were taken for. The macOS package has none of these files.

| Files | From | Terms | Text in the notices |
| --- | --- | --- | --- |
| lib/ollama/cuda_v12/msvcp140.dll, msvcp140_1.dll, msvcp140_2.dll, msvcp140_atomic_wait.dll, msvcp140_codecvt_ids.dll, vcruntime140.dll, vcruntime140_1.dll, vcruntime140_threads.dll, concrt140.dll, vccorlib140.dll | Microsoft Visual C++ runtime 14.44.35211.0 (Visual Studio 2022; FileVersion of the DLLs) | Distributable Code under the Visual Studio 2022 license terms (https://visualstudio.microsoft.com/license-terms/vs2022-ga-community/, section "Distributable Code"; the files are in VC\redist, which https://aka.ms/vs/17/redistribution allows to distribute unmodified). Distribution requirements: add significant primary functionality, and "require distributors and external end users to agree to terms that protect the Distributable Code at least as much as this agreement". The runtime's own license terms (Microsoft Visual C++ 2015 - 2022 Runtime) are reproduced. | Microsoft Visual C++ 2015 - 2022 Runtime license terms, from https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/ (Visual-C-Runtime-2015-2022-License-1.docx, EULA ID Cpp_2015-2022_ENU.1033), text without Word's automatic list numbering |
| lib/ollama/libc++.dll, libunwind.dll, libomp.dll | LLVM 18.1.8 runtimes, built by llvm-mingw 20240619 from llvm-project llvmorg-18.1.8 (commit 3b5b5c1ec4a3095ab096dd780e84d7ab81f3d7ff, named in the DLLs) | Apache License 2.0 with LLVM Exceptions (and the legacy dual NCSA/MIT license of these subprojects) | libcxx/LICENSE.TXT, libunwind/LICENSE.TXT and openmp/LICENSE.TXT at llvmorg-18.1.8 |
| lib/ollama/libwinpthread-1.dll | MinGW-w64 winpthreads, built by llvm-mingw 20240619 from mingw-w64 commit 7c9cfe6708cafc83c14a2654308b2db62b126eae | MIT, and the BSD-style license of the Lockless Inc. code it derives from | mingw-w64-libraries/winpthreads/COPYING at that commit |
| lib/ollama/cuda_v12/cudart64_12.dll, cublas64_12.dll, cublasLt64_12.dll | NVIDIA CUDA Toolkit 12 | NVIDIA CUDA Toolkit EULA (https://docs.nvidia.com/cuda/eula/index.html). Attachment A lists the CUDA Runtime and cuBLAS/cuBLASLt Windows DLLs as distributable with an application. Section 1.1.2: the application adds material functionality beyond the SDK, only the application accesses these files, and the terms it is distributed under are consistent with the EULA; section 1.2 forbids distributing the SDK as a stand-alone product and using it in a way that would make it subject to an open source license. | No text required; listed by name with the EULA link |
| lib/ollama/cuda_v12/ggml-cuda.dll, the other ggml and llama DLLs, llama-server.exe, llama-quantize.exe, ollama.exe | Ollama, llama.cpp and ggml | MIT; the archive's license files (LLAMA_CPP_LICENSE, CUDNN_LICENSE.txt, CUTLASS_LICENSE.txt, NVTX3_LICENSE.txt and the others) stay in the folder | Listed by name |

Open points for the Windows build, not resolved here: the installer shows no license page, so end users do not actively agree to the Microsoft runtime terms that the Visual Studio terms ask distributors to require; and whether the NVIDIA EULA's conditions hold for an app whose own code is AGPL-3.0-only, while the CUDA files are part of the separately licensed Ollama (MIT), needs a lawyer's confirmation (docs/plan.md, Before formal release).

### Windows runtime license texts

These are the texts THIRD-PARTY-NOTICES carries on the Windows package; scripts/lib/windows-runtimes.test.mjs and scripts/license-report.test.mjs check that both match the files in scripts/notices.

<details>
<summary>Microsoft Visual C++ 2015-2022 Runtime 14.44 (Visual Studio 2022): msvc-runtime-LICENSE.txt</summary>

```text
MICROSOFT SOFTWARE LICENSE TERMS
MICROSOFT VISUAL C++ 2015 - 2022 RUNTIME
These license terms are an agreement between Microsoft Corporation (or based on where you live, one of its affiliates) and you. They apply to the software named above. The terms also apply to any Microsoft services or updates for the software, except to the extent those have different terms.
IF YOU COMPLY WITH THESE LICENSE TERMS, YOU HAVE THE RIGHTS BELOW.
INSTALLATION AND USE RIGHTS.
You may install and use any number of copies of the software.
TERMS FOR SPECIFIC COMPONENTS.
Microsoft Platforms. The software may include components from Microsoft Windows; Microsoft Windows Server; Microsoft SQL Server; Microsoft Exchange; Microsoft Office; and Microsoft SharePoint. These components are governed by separate agreements and their own product support policies, as described in the Microsoft “Licenses” folder accompanying the software, except that, if license terms for those components are also included in the associated installation directory, those license terms control.
Third Party Components. The software may include third party components with separate legal notices or governed by other agreements, as may be described in the notices file(s) accompanying the software.
SCOPE OF LICENSE. The software is licensed, not sold. This agreement only gives you some rights to use the software. Microsoft reserves all other rights. Unless applicable law gives you more rights despite this limitation, you may use the software only as expressly permitted in this agreement. In doing so, you must comply with any technical limitations in the software that only allow you to use it in certain ways. You may not
work around any technical limitations in the software;
reverse engineer, decompile or disassemble the software, or otherwise attempt to derive the source code for the software except, and only to the extent required by third party licensing terms governing the use of certain open source components that may be included in the software;
remove, minimize, block or modify any notices of Microsoft or its suppliers in the software;
use the software in any way that is against the law;
share, publish, rent or lease the software; or
provide the software as a stand-alone offering or combined with any of your applications for others to use, or transfer the software or this agreement to any third party.
EXPORT RESTRICTIONS. You must comply with all domestic and international export laws and regulations that apply to the software, which include restrictions on destinations, end users, and end use. For further information on export restrictions, visit www.microsoft.com/exporting.
SUPPORT SERVICES. Because this software is “as is,” we may not provide support services for it.
ENTIRE AGREEMENT. This agreement, and the terms for supplements, updates, Internet-based services and support services that you use, are the entire agreement for the software and support services.
APPLICABLE LAW. If you acquired the software in the United States, Washington law applies to interpretation of and claims for breach of this agreement, and the laws of the state where you live apply to all other claims. If you acquired the software in any other country, its laws apply.
CONSUMER RIGHTS; REGIONAL VARIATIONS. This agreement describes certain legal rights. You may have other rights, including consumer rights, under the laws of your state or country. Separate and apart from your relationship with Microsoft, you may also have rights with respect to the party from which you acquired the software. This agreement does not change those other rights if the laws of your state or country do not permit it to do so. For example, if you acquired the software in one of the below regions, or mandatory country law applies, then the following provisions apply to you:
Australia. You have statutory guarantees under the Australian Consumer Law and nothing in this agreement is intended to affect those rights.
Canada. If you acquired this software in Canada, you may stop receiving updates by turning off the automatic update feature, disconnecting your device from the Internet (if and when you re-connect to the Internet, however, the software will resume checking for and installing updates), or uninstalling the software. The product documentation, if any, may also specify how to turn off updates for your specific device or software.
Germany and Austria.
(i)Warranty. The properly licensed software will perform substantially as described in any Microsoft materials that accompany the software. However, Microsoft gives no contractual guarantee in relation to the licensed software.
(ii)Limitation of Liability. In case of intentional conduct, gross negligence, claims based on the Product Liability Act, as well as, in case of death or personal or physical injury, Microsoft is liable according to the statutory law.
Subject to the foregoing clause (ii), Microsoft will only be liable for slight negligence if Microsoft is in breach of such material contractual obligations, the fulfillment of which facilitate the due performance of this agreement, the breach of which would endanger the purpose of this agreement and the compliance with which a party may constantly trust in (so-called "cardinal obligations"). In other cases of slight negligence, Microsoft will not be liable for slight negligence.
DISCLAIMER OF WARRANTY. THE SOFTWARE IS LICENSED “AS-IS.” YOU BEAR THE RISK OF USING IT. MICROSOFT GIVES NO EXPRESS WARRANTIES, GUARANTEES OR CONDITIONS. TO THE EXTENT PERMITTED UNDER YOUR LOCAL LAWS, MICROSOFT EXCLUDES THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT.
LIMITATION ON AND EXCLUSION OF DAMAGES. YOU CAN RECOVER FROM MICROSOFT AND ITS SUPPLIERS ONLY DIRECT DAMAGES UP TO U.S. $5.00. YOU CANNOT RECOVER ANY OTHER DAMAGES, INCLUDING CONSEQUENTIAL, LOST PROFITS, SPECIAL, INDIRECT OR INCIDENTAL DAMAGES.
This limitation applies to (a) anything related to the software, services, content (including code) on third party Internet sites, or third party applications; and (b) claims for breach of contract, breach of warranty, guarantee or condition, strict liability, negligence, or other tort to the extent permitted by applicable law.
It also applies even if Microsoft knew or should have known about the possibility of the damages. The above limitation or exclusion may not apply to you because your country may not allow the exclusion or limitation of incidental, consequential or other damages.

EULA ID: Cpp_2015-2022_ENU.1033
```

</details>

<details>
<summary>LLVM runtimes 18.1.8: libc++, libunwind, OpenMP (libomp): llvm-libcxx-LICENSE.TXT</summary>

```text
==============================================================================
The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:
==============================================================================

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

    TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

    1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

    2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

    3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

    4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

    5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

    6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

    7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

    8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

    9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

    END OF TERMS AND CONDITIONS

    APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

    Copyright [yyyy] [name of copyright owner]

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.


---- LLVM Exceptions to the Apache 2.0 License ----

As an exception, if, as a result of your compiling your source code, portions
of this Software are embedded into an Object form of such source code, you
may redistribute such embedded portions in such Object form without complying
with the conditions of Sections 4(a), 4(b) and 4(d) of the License.

In addition, if you combine or link compiled forms of this Software with
software that is licensed under the GPLv2 ("Combined Software") and if a
court of competent jurisdiction determines that the patent provision (Section
3), the indemnity provision (Section 9) or other Section of the License
conflicts with the conditions of the GPLv2, you may retroactively and
prospectively choose to deem waived or otherwise exclude such Section(s) of
the License, but only in their entirety and only with respect to the Combined
Software.

==============================================================================
Software from third parties included in the LLVM Project:
==============================================================================
The LLVM Project contains third party software which is under different license
terms. All such code will be identified clearly using at least one of two
mechanisms:
1) It will be in a separate directory tree with its own `LICENSE.txt` or
   `LICENSE` file at the top containing the specific license and restrictions
   which apply to that software, or
2) It will contain specific license and restriction terms at the top of every
   file.

==============================================================================
Legacy LLVM License (https://llvm.org/docs/DeveloperPolicy.html#legacy):
==============================================================================

The libc++ library is dual licensed under both the University of Illinois
"BSD-Like" license and the MIT license.  As a user of this code you may choose
to use it under either license.  As a contributor, you agree to allow your code
to be used under both.

Full text of the relevant licenses is included below.

==============================================================================

University of Illinois/NCSA
Open Source License

Copyright (c) 2009-2019 by the contributors listed in CREDITS.TXT

All rights reserved.

Developed by:

    LLVM Team

    University of Illinois at Urbana-Champaign

    http://llvm.org

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal with
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimers.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimers in the
      documentation and/or other materials provided with the distribution.

    * Neither the names of the LLVM Team, University of Illinois at
      Urbana-Champaign, nor the names of its contributors may be used to
      endorse or promote products derived from this Software without specific
      prior written permission.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
SOFTWARE.

==============================================================================

Copyright (c) 2009-2014 by the contributors listed in CREDITS.TXT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

</details>

<details>
<summary>LLVM runtimes 18.1.8: libc++, libunwind, OpenMP (libomp): llvm-libunwind-LICENSE.TXT</summary>

```text
==============================================================================
The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:
==============================================================================

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

    TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

    1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

    2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

    3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

    4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

    5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

    6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

    7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

    8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

    9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

    END OF TERMS AND CONDITIONS

    APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

    Copyright [yyyy] [name of copyright owner]

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.


---- LLVM Exceptions to the Apache 2.0 License ----

As an exception, if, as a result of your compiling your source code, portions
of this Software are embedded into an Object form of such source code, you
may redistribute such embedded portions in such Object form without complying
with the conditions of Sections 4(a), 4(b) and 4(d) of the License.

In addition, if you combine or link compiled forms of this Software with
software that is licensed under the GPLv2 ("Combined Software") and if a
court of competent jurisdiction determines that the patent provision (Section
3), the indemnity provision (Section 9) or other Section of the License
conflicts with the conditions of the GPLv2, you may retroactively and
prospectively choose to deem waived or otherwise exclude such Section(s) of
the License, but only in their entirety and only with respect to the Combined
Software.

==============================================================================
Software from third parties included in the LLVM Project:
==============================================================================
The LLVM Project contains third party software which is under different license
terms. All such code will be identified clearly using at least one of two
mechanisms:
1) It will be in a separate directory tree with its own `LICENSE.txt` or
   `LICENSE` file at the top containing the specific license and restrictions
   which apply to that software, or
2) It will contain specific license and restriction terms at the top of every
   file.

==============================================================================
Legacy LLVM License (https://llvm.org/docs/DeveloperPolicy.html#legacy):
==============================================================================

The libunwind library is dual licensed under both the University of Illinois
"BSD-Like" license and the MIT license.  As a user of this code you may choose
to use it under either license.  As a contributor, you agree to allow your code
to be used under both.

Full text of the relevant licenses is included below.

==============================================================================

University of Illinois/NCSA
Open Source License

Copyright (c) 2009-2019 by the contributors listed in CREDITS.TXT

All rights reserved.

Developed by:

    LLVM Team

    University of Illinois at Urbana-Champaign

    http://llvm.org

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal with
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimers.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimers in the
      documentation and/or other materials provided with the distribution.

    * Neither the names of the LLVM Team, University of Illinois at
      Urbana-Champaign, nor the names of its contributors may be used to
      endorse or promote products derived from this Software without specific
      prior written permission.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
SOFTWARE.

==============================================================================

Copyright (c) 2009-2014 by the contributors listed in CREDITS.TXT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

</details>

<details>
<summary>LLVM runtimes 18.1.8: libc++, libunwind, OpenMP (libomp): llvm-openmp-LICENSE.TXT</summary>

```text
==============================================================================
The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:
==============================================================================

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

    TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

    1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

    2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

    3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

    4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

    5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

    6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

    7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

    8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

    9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

    END OF TERMS AND CONDITIONS

    APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

    Copyright [yyyy] [name of copyright owner]

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.


---- LLVM Exceptions to the Apache 2.0 License ----

As an exception, if, as a result of your compiling your source code, portions
of this Software are embedded into an Object form of such source code, you
may redistribute such embedded portions in such Object form without complying
with the conditions of Sections 4(a), 4(b) and 4(d) of the License.

In addition, if you combine or link compiled forms of this Software with
software that is licensed under the GPLv2 ("Combined Software") and if a
court of competent jurisdiction determines that the patent provision (Section
3), the indemnity provision (Section 9) or other Section of the License
conflicts with the conditions of the GPLv2, you may retroactively and
prospectively choose to deem waived or otherwise exclude such Section(s) of
the License, but only in their entirety and only with respect to the Combined
Software.

==============================================================================
Software from third parties included in the LLVM Project:
==============================================================================
The LLVM Project contains third party software which is under different license
terms. All such code will be identified clearly using at least one of two
mechanisms:
1) It will be in a separate directory tree with its own `LICENSE.txt` or
   `LICENSE` file at the top containing the specific license and restrictions
   which apply to that software, or
2) It will contain specific license and restriction terms at the top of every
   file.

==============================================================================
Legacy LLVM License (https://llvm.org/docs/DeveloperPolicy.html#legacy):
==============================================================================

The software contained in this directory tree is dual licensed under both the
University of Illinois "BSD-Like" license and the MIT license.  As a user of
this code you may choose to use it under either license.  As a contributor,
you agree to allow your code to be used under both.  The full text of the
relevant licenses is included below.

In addition, a license agreement from the copyright/patent holders of the
software contained in this directory tree is included below.

==============================================================================

University of Illinois/NCSA
Open Source License

Copyright (c) 1997-2019 Intel Corporation

All rights reserved.

Developed by:
    OpenMP Runtime Team
    Intel Corporation
    http://www.openmprtl.org

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal with
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimers.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimers in the
      documentation and/or other materials provided with the distribution.

    * Neither the names of Intel Corporation OpenMP Runtime Team nor the
      names of its contributors may be used to endorse or promote products
      derived from this Software without specific prior written permission.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
SOFTWARE.

==============================================================================

Copyright (c) 1997-2019 Intel Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

==============================================================================

Intel Corporation

Software Grant License Agreement ("Agreement")

Except for the license granted herein to you, Intel Corporation ("Intel") reserves
all right, title, and interest in and to the Software (defined below).

Definition

"Software" means the code and documentation as well as any original work of
authorship, including any modifications or additions to an existing work, that
is intentionally submitted by Intel to llvm.org (http://llvm.org) ("LLVM") for
inclusion in, or documentation of, any of the products owned or managed by LLVM
(the "Work"). For the purposes of this definition, "submitted" means any form of
electronic, verbal, or written communication sent to LLVM or its
representatives, including but not limited to communication on electronic
mailing lists, source code control systems, and issue tracking systems that are
managed by, or on behalf of, LLVM for the purpose of discussing and improving
the Work, but excluding communication that is conspicuously marked otherwise.

1. Grant of Copyright License. Subject to the terms and conditions of this
   Agreement, Intel hereby grants to you and to recipients of the Software
   distributed by LLVM a perpetual, worldwide, non-exclusive, no-charge,
   royalty-free, irrevocable copyright license to reproduce, prepare derivative
   works of, publicly display, publicly perform, sublicense, and distribute the
   Software and such derivative works.

2. Grant of Patent License. Subject to the terms and conditions of this
   Agreement, Intel hereby grants you and to recipients of the Software
   distributed by LLVM a perpetual, worldwide, non-exclusive, no-charge,
   royalty-free, irrevocable (except as stated in this section) patent license
   to make, have made, use, offer to sell, sell, import, and otherwise transfer
   the Work, where such license applies only to those patent claims licensable
   by Intel that are necessarily infringed by Intel's Software alone or by
   combination of the Software with the Work to which such Software was
   submitted. If any entity institutes patent litigation against Intel or any
   other entity (including a cross-claim or counterclaim in a lawsuit) alleging
   that Intel's Software, or the Work to which Intel has contributed constitutes
   direct or contributory patent infringement, then any patent licenses granted
   to that entity under this Agreement for the Software or Work shall terminate
   as of the date such litigation is filed.

Unless required by applicable law or agreed to in writing, the software is
provided on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
either express or implied, including, without limitation, any warranties or
conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
PARTICULAR PURPOSE.

==============================================================================
```

</details>

<details>
<summary>MinGW-w64 winpthreads (libwinpthread-1.dll): winpthreads-COPYING</summary>

```text
Copyright (c) 2011 mingw-w64 project

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.


/*
 * Parts of this library are derived by:
 *
 * Posix Threads library for Microsoft Windows
 *
 * Use at own risk, there is no implied warranty to this code.
 * It uses undocumented features of Microsoft Windows that can change
 * at any time in the future.
 *
 * (C) 2010 Lockless Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *
 *  * Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *  * Neither the name of Lockless Inc. nor the names of its contributors may be
 *    used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AN
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 * IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 * INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
 * BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
 * OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED
 * OF THE POSSIBILITY OF SUCH DAMAGE.
 */
```

</details>


## Notes on the packages outside the allowed list

Read by hand; the tables below the marker are the script's output.

- LGPL-3.0-or-later: @img/sharp-libvips-darwin-arm64 (collector, through sharp 0.33) and the libvips 8.14.5 build inside the two copies of sharp 0.32.6 (server, and collector under @xenova/transformers; their own field says Apache-2.0, the THIRD-PARTY-NOTICES.md in their vendor folder lists the LGPL libraries). Dynamically linked shared libraries, shipped unmodified. THIRD-PARTY-NOTICES carries the LGPL-3.0 text with the GPL-3.0 text it builds on, and, since 2026-11-10, where the source of every shipped version is (section "Source code of the LGPL libraries", the same as below). FFmpeg inside Electron (LGPL-2.1, text in LICENSES.chromium.html) has its source pointer there too.
- MPL-2.0, web-push (server). Accepted by the owner as long as its files are not modified (they are not); shipped as its JavaScript source. Not pruned: server/utils/PushNotifications/index.js requires it at module scope and is loaded at server start. cairo inside libvips is MPL-2.0 as well; its source is listed with the LGPL libraries.
- BlueOak-1.0.0, sax, jackspeak, path-scurry, package-json-from-dist: permissive, not on the allowed list.
- MIT-0 (@csstools/color-helpers, nodemailer), (MIT AND Zlib) (pako), BSD without a variant (duck): permissive, not on the allowed list as written.
- No license statement in the package (no license field, no license file, and the readme states none):
  - voyageai 0.0.3: removed by prune step providers; it came only with chromadb.
  - buffers 0.1.1: came only with exceljs (exceljs > unzipper > binary > buffers), which upstream loads only for the agent's create-spreadsheet skill, a path AskFiles never reaches. Since 2026-11-10 scripts/prune.mjs removes exceljs as unused, and buffers with it (docs/bundle-report.md, step 4). No longer shipped.
  - combine-errors 3.0.3: server, @mintplex-labs/bree > combine-errors. Its readme states MIT under a License heading; THIRD-PARTY-NOTICES records MIT from the readme. On a path AskFiles uses. Left in place.
- Development dependencies (MPL-2.0 lightningcss, WTFPL truncate-utf8-bytes, BlueOak-1.0.0) are never shipped.

<!-- Generated by node scripts/license-report.mjs <resources-dir> from the packaged app: do not edit below this line. -->

## Source code of the LGPL libraries

AskFiles ships the libraries below as separate shared libraries, as their projects build them, without
changes by AskFiles. They are covered by the GNU Lesser General Public License (cairo by the Mozilla Public
License 2.0); you may replace them with your own builds. Their complete source code, at the versions
shipped, is available at these locations:

- libvips 8.14.5 and the libraries built into it
  Shipped in: sharp@0.32.6 (upstream collector), sharp@0.32.6 (upstream server)
  Built by https://github.com/lovell/sharp-libvips at commit e3585e7e2de7c0a9f0fe81c2bd9a559bebc65f87 (tag v8.14.5):
  https://github.com/lovell/sharp-libvips/tree/e3585e7e2de7c0a9f0fe81c2bd9a559bebc65f87
  Its build/lin.sh downloads each source below and applies the patches it names.
  - libvips 8.14.5 (LGPL): https://github.com/libvips/libvips/releases/download/v8.14.5/vips-8.14.5.tar.xz
  - GLib 2.78.0 (LGPL): https://download.gnome.org/sources/glib/2.78/glib-2.78.0.tar.xz
  - FriBidi 1.0.13 (LGPL): https://github.com/fribidi/fribidi/releases/download/v1.0.13/fribidi-1.0.13.tar.xz
  - GdkPixbuf 2.42.10 (LGPL): https://download.gnome.org/sources/gdk-pixbuf/2.42/gdk-pixbuf-2.42.10.tar.xz
  - libexif 0.6.24 (LGPL): https://github.com/libexif/libexif/releases/download/v0.6.24/libexif-0.6.24.tar.bz2
  - libheif 1.16.2 (LGPL): https://github.com/strukturag/libheif/releases/download/v1.16.2/libheif-1.16.2.tar.gz
  - librsvg 2.57.0 (LGPL): https://download.gnome.org/sources/librsvg/2.57/librsvg-2.57.0.tar.xz
  - Pango 1.51.0 (LGPL): https://download.gnome.org/sources/pango/1.51/pango-1.51.0.tar.xz
  - proxy-libintl 0.4 (LGPL): https://github.com/frida/proxy-libintl/archive/0.4.tar.gz
  - cairo 1.17.8 (MPL-2.0): https://gitlab.freedesktop.org/cairo/cairo/-/archive/1.17.8/cairo-1.17.8.tar.bz2
- libvips 8.15.3 and the libraries built into it
  Shipped in: @img/sharp-libvips-darwin-arm64@1.0.4 (upstream collector)
  Built by https://github.com/lovell/sharp-libvips at commit cb57c8e09460fa0b5c550806b667a2dfc3f7480b (tag v8.15.3):
  https://github.com/lovell/sharp-libvips/tree/cb57c8e09460fa0b5c550806b667a2dfc3f7480b
  Its build/lin.sh downloads each source below and applies the patches it names.
  - libvips 8.15.3 (LGPL): https://github.com/libvips/libvips/releases/download/v8.15.3/vips-8.15.3.tar.xz
  - GLib 2.81.1 (LGPL): https://download.gnome.org/sources/glib/2.81/glib-2.81.1.tar.xz
  - FriBidi 1.0.15 (LGPL): https://github.com/fribidi/fribidi/releases/download/v1.0.15/fribidi-1.0.15.tar.xz
  - libexif 0.6.24 (LGPL): https://github.com/libexif/libexif/releases/download/v0.6.24/libexif-0.6.24.tar.bz2
  - libheif 1.18.2 (LGPL): https://github.com/strukturag/libheif/releases/download/v1.18.2/libheif-1.18.2.tar.gz
  - librsvg 2.58.93 (LGPL): https://download.gnome.org/sources/librsvg/2.58/librsvg-2.58.93.tar.xz
  - Pango 1.54.0 (LGPL): https://download.gnome.org/sources/pango/1.54/pango-1.54.0.tar.xz
  - proxy-libintl 0.4 (LGPL): https://github.com/frida/proxy-libintl/archive/0.4.tar.gz
  - cairo 1.18.0 (MPL-2.0): https://cairographics.org/releases/cairo-1.18.0.tar.xz
- FFmpeg in Electron 44.10.0 (libffmpeg in the Electron framework)
  License: LGPL-2.1; its text is in LICENSES.chromium.html in the app resources.
  Chromium 152.0.7977.169's copy at revision 2b68d2babae73714846961fb0ee47e3b3d2e39a9, with Chromium's build configuration
  in its chromium/ folder:
  https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/2b68d2babae73714846961fb0ee47e3b3d2e39a9

## Licenses outside the allowed list

Allowed: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense, Python-2.0, CC0-1.0. 26 packages, first dependency path found:

| Tree | Package | License | Pulled in by |
| --- | --- | --- | --- |
| Packaged server dependencies | @csstools/color-helpers 5.1.0 | MIT-0 | jsdom > cssstyle > @asamuzakjp/css-color > @csstools/css-color-parser > @csstools/color-helpers |
| Packaged server dependencies | combine-errors 3.0.3 | UNKNOWN | @mintplex-labs/bree > combine-errors |
| Packaged server dependencies | pako 1.0.11 | (MIT AND Zlib) | pdf-lib > pako |
| Packaged server dependencies | sax 1.6.0 | BlueOak-1.0.0 | docx > xml-js > sax |
| Packaged server dependencies | web-push 3.6.7 | MPL-2.0 | web-push |
| Packaged collector dependencies | @img/sharp-libvips-darwin-arm64 1.0.4 | LGPL-3.0-or-later | sharp > @img/sharp-libvips-darwin-arm64 |
| Packaged collector dependencies | duck 0.1.12 | BSD | mammoth > lop > duck |
| Packaged collector dependencies | jackspeak 3.4.3 | BlueOak-1.0.0 | officeparser > rimraf > glob > jackspeak |
| Packaged collector dependencies | nodemailer 7.0.10 | MIT-0 | mbox-parser > mailparser > nodemailer |
| Packaged collector dependencies | package-json-from-dist 1.0.1 | BlueOak-1.0.0 | officeparser > rimraf > glob > package-json-from-dist |
| Packaged collector dependencies | pako 1.0.11 | (MIT AND Zlib) | mammoth > jszip > pako |
| Packaged collector dependencies | path-scurry 1.11.1 | BlueOak-1.0.0 | officeparser > rimraf > glob > path-scurry |
| Packaged collector dependencies | sax 1.4.3 | BlueOak-1.0.0 | epub2 > xml2js > sax |
| Shell runtime dependencies (app.asar) | pako 1.0.11 | (MIT AND Zlib) | mammoth > jszip > pako |
| Shell runtime dependencies (app.asar) | duck 0.1.12 | BSD | mammoth > lop > duck |
| Shell development dependencies (not shipped) | minimatch 10.2.6 | BlueOak-1.0.0 | eslint > minimatch |
| Shell development dependencies (not shipped) | tar 7.5.22 | BlueOak-1.0.0 | electron-builder > app-builder-lib > tar |
| Shell development dependencies (not shipped) | sax 1.6.1 | BlueOak-1.0.0 | electron-builder > builder-util-runtime > sax |
| Shell development dependencies (not shipped) | lightningcss 1.33.0 | MPL-2.0 | vitest > vite > lightningcss |
| Shell development dependencies (not shipped) | chownr 3.0.0 | BlueOak-1.0.0 | electron-builder > app-builder-lib > tar > chownr |
| Shell development dependencies (not shipped) | minipass 7.1.3 | BlueOak-1.0.0 | electron-builder > app-builder-lib > tar > minipass |
| Shell development dependencies (not shipped) | yallist 5.0.0 | BlueOak-1.0.0 | electron-builder > app-builder-lib > tar > yallist |
| Shell development dependencies (not shipped) | isexe 3.1.5 | BlueOak-1.0.0 | electron-builder > app-builder-lib > which > isexe |
| Shell development dependencies (not shipped) | truncate-utf8-bytes 1.0.2 | WTFPL | electron-builder > builder-util > sanitize-filename > truncate-utf8-bytes |
| Shell development dependencies (not shipped) | lightningcss-darwin-arm64 1.33.0 | MPL-2.0 | vitest > vite > lightningcss > lightningcss-darwin-arm64 |
| Shell development dependencies (not shipped) | isexe 4.0.0 | BlueOak-1.0.0 | electron-builder > app-builder-lib > @electron/rebuild > node-gyp > which > isexe |

## Packaged server dependencies

768 packages (name and version).

| Package | Version | License |
| --- | --- | --- |
| .prisma | ? | Apache-2.0 (generated by @prisma/client) |
| @75lb/deep-merge | 1.1.2 | MIT |
| @anthropic-ai/sdk | 0.20.9 | MIT |
| @anthropic-ai/sdk | 0.39.0 | MIT |
| @anthropic-ai/sdk | 0.9.1 | MIT |
| @asamuzakjp/css-color | 3.2.0 | MIT |
| @azure/abort-controller | 1.1.0 | MIT |
| @azure/abort-controller | 2.1.2 | MIT |
| @azure/core-auth | 1.7.2 | MIT |
| @azure/core-client | 1.9.2 | MIT |
| @azure/core-http-compat | 2.1.2 | MIT |
| @azure/core-lro | 2.7.2 | MIT |
| @azure/core-paging | 1.6.2 | MIT |
| @azure/core-rest-pipeline | 1.16.0 | MIT |
| @azure/core-tracing | 1.1.2 | MIT |
| @azure/core-util | 1.9.0 | MIT |
| @azure/identity | 3.4.2 | MIT |
| @azure/keyvault-keys | 4.8.0 | MIT |
| @azure/logger | 1.1.2 | MIT |
| @azure/msal-browser | 3.14.0 | MIT |
| @azure/msal-common | 14.10.0 | MIT |
| @azure/msal-node | 2.8.1 | MIT |
| @babel/runtime | 7.24.7 | MIT |
| @breejs/later | 4.2.0 | MIT |
| @colors/colors | 1.6.0 | MIT |
| @csstools/color-helpers | 5.1.0 | MIT-0 |
| @csstools/css-calc | 2.1.4 | MIT |
| @csstools/css-color-parser | 3.1.0 | MIT |
| @csstools/css-parser-algorithms | 3.0.5 | MIT |
| @csstools/css-tokenizer | 3.0.4 | MIT |
| @cypress/request | 3.0.10 | Apache-2.0 |
| @cypress/request-promise | 5.0.0 | ISC |
| @dabh/diagnostics | 2.0.3 | MIT |
| @hapi/hoek | 9.3.0 | BSD-3-Clause |
| @hapi/topo | 5.1.0 | BSD-3-Clause |
| @huggingface/jinja | 0.2.2 | MIT |
| @js-joda/core | 5.6.2 | BSD-3-Clause |
| @kurkle/color | 0.3.4 | MIT |
| @ladjs/graceful | 3.2.2 | MIT |
| @lancedb/lancedb | 0.15.0 | Apache 2.0 |
| @lancedb/lancedb-darwin-arm64 | 0.15.0 | Apache 2.0 |
| @langchain/anthropic | 0.1.16 | MIT |
| @langchain/community | 0.0.53 | MIT |
| @langchain/core | 0.1.61 | MIT |
| @langchain/openai | 0.0.28 | MIT |
| @langchain/textsplitters | 0.0.0 | MIT |
| @mintplex-labs/bree | 9.2.6 | MIT |
| @mintplex-labs/express-ws | 5.0.7 | BSD-2-Clause |
| @modelcontextprotocol/sdk | 1.24.3 | MIT |
| @pdf-lib/standard-fonts | 1.0.0 | MIT |
| @pdf-lib/upng | 1.0.1 | MIT |
| @prisma/client | 5.3.1 | Apache-2.0 |
| @prisma/engines | 5.3.1 | Apache-2.0 |
| @prisma/engines-version | 5.3.1-2.61e140623197a131c2a6189271ffee05a7aa9a59 | Apache-2.0 |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause |
| @protobufjs/codegen | 2.0.4 | BSD-3-Clause |
| @protobufjs/eventemitter | 1.1.0 | BSD-3-Clause |
| @protobufjs/fetch | 1.1.0 | BSD-3-Clause |
| @protobufjs/float | 1.0.2 | BSD-3-Clause |
| @protobufjs/inquire | 1.1.0 | BSD-3-Clause |
| @protobufjs/path | 1.1.2 | BSD-3-Clause |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause |
| @protobufjs/utf8 | 1.1.0 | BSD-3-Clause |
| @sideway/address | 4.1.5 | BSD-3-Clause |
| @sideway/formula | 3.0.1 | BSD-3-Clause |
| @sideway/pinpoint | 2.0.0 | BSD-3-Clause |
| @swc/helpers | 0.5.15 | Apache-2.0 |
| @tediousjs/connection-string | 0.5.0 | MIT |
| @types/readable-stream | 4.0.14 | MIT |
| @vscode/ripgrep | 1.17.1 | MIT |
| @xenova/transformers | 2.17.2 | Apache-2.0 |
| abort-controller | 3.0.0 | MIT |
| accepts | 1.3.8 | MIT |
| accepts | 2.0.0 | MIT |
| acorn | 7.4.1 | MIT |
| adm-zip | 0.5.16 | MIT |
| agent-base | 7.1.1 | MIT |
| agent-base | 7.1.4 | MIT |
| agentkeepalive | 4.5.0 | MIT |
| ajv | 8.17.1 | MIT |
| ajv-formats | 3.0.1 | MIT |
| ansi-regex | 6.2.2 | MIT |
| ansi-styles | 4.3.0 | MIT |
| ansi-styles | 5.2.0 | MIT |
| apache-arrow | 19.0.0 | Apache-2.0 |
| append-field | 1.0.0 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| array-back | 3.1.0 | MIT |
| array-back | 6.2.2 | MIT |
| array-buffer-byte-length | 1.0.1 | MIT |
| array-buffer-byte-length | 1.0.2 | MIT |
| array-flatten | 1.1.1 | MIT |
| array.prototype.findindex | 2.2.4 | MIT |
| arraybuffer.prototype.slice | 1.0.3 | MIT |
| arraybuffer.prototype.slice | 1.0.4 | MIT |
| asn1 | 0.2.6 | MIT |
| asn1.js | 5.4.1 | MIT |
| assert-plus | 1.0.0 | MIT |
| async | 3.2.5 | MIT |
| asynckit | 0.4.0 | MIT |
| available-typed-arrays | 1.0.7 | MIT |
| aws-sign2 | 0.7.0 | Apache-2.0 |
| aws-ssl-profiles | 1.1.1 | MIT |
| aws4 | 1.13.2 | MIT |
| axios | 1.6.8 | MIT |
| b4a | 1.6.6 | Apache-2.0 |
| balanced-match | 1.0.2 | MIT |
| bare-events | 2.2.2 | Apache-2.0 |
| bare-fs | 2.3.0 | Apache-2.0 |
| bare-os | 2.3.0 | Apache-2.0 |
| bare-path | 2.1.2 | Apache-2.0 |
| bare-stream | 1.0.0 | Apache-2.0 |
| base-64 | 0.1.0 | MIT |
| base64-js | 1.5.1 | MIT |
| bcrypt-pbkdf | 1.0.2 | BSD-3-Clause |
| bcryptjs | 3.0.3 | BSD-3-Clause |
| binary-extensions | 2.3.0 | MIT |
| binary-search | 1.3.6 | CC0-1.0 |
| bl | 1.2.3 | MIT |
| bl | 4.1.0 | MIT |
| bl | 6.0.12 | MIT |
| bluebird | 3.7.2 | MIT |
| bn.js | 4.12.2 | MIT |
| body-parser | 1.20.4 | MIT |
| body-parser | 2.2.1 | MIT |
| boolbase | 1.0.0 | ISC |
| boolean | 3.2.0 | MIT |
| brace-expansion | 1.1.11 | MIT |
| buffer | 5.7.1 | MIT |
| buffer | 6.0.3 | MIT |
| buffer-crc32 | 0.2.13 | MIT |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause |
| buffer-from | 1.1.2 | MIT |
| busboy | 1.6.0 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind | 1.0.7 | MIT |
| call-bind | 1.0.8 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| camelcase | 6.3.0 | MIT |
| caseless | 0.12.0 | Apache-2.0 |
| chalk | 4.1.2 | MIT |
| chalk-template | 0.4.0 | MIT |
| charenc | 0.0.2 | BSD-3-Clause |
| chart.js | 4.5.1 | MIT |
| check-disk-space | 3.4.0 | MIT |
| cheerio | 1.0.0 | MIT |
| cheerio-select | 2.1.0 | BSD-2-Clause |
| chownr | 1.1.4 | ISC |
| cohere-ai | 7.9.5 | MIT (from LICENSE file) |
| color | 3.2.1 | MIT |
| color | 4.2.3 | MIT |
| color-convert | 1.9.3 | MIT |
| color-convert | 2.0.1 | MIT |
| color-name | 1.1.3 | MIT |
| color-name | 1.1.4 | MIT |
| color-string | 1.9.1 | MIT |
| colors | 1.4.0 | MIT |
| colorspace | 1.1.4 | MIT |
| combine-errors | 3.0.3 | UNKNOWN |
| combined-stream | 1.0.8 | MIT |
| command-exists | 1.2.9 | MIT |
| command-line-args | 5.2.1 | MIT |
| command-line-args | 6.0.1 | MIT |
| command-line-usage | 7.0.1 | MIT |
| command-line-usage | 7.0.3 | MIT |
| commander | 10.0.1 | MIT |
| commander | 11.1.0 | MIT |
| commander | 8.3.0 | MIT |
| concat-map | 0.0.1 | MIT |
| concat-stream | 1.6.2 | MIT |
| content-disposition | 0.5.4 | MIT |
| content-disposition | 1.0.1 | MIT |
| content-type | 1.0.5 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.0.7 | MIT |
| cookie-signature | 1.2.2 | MIT |
| core-util-is | 1.0.2 | MIT |
| core-util-is | 1.0.3 | MIT |
| cors | 2.8.5 | MIT |
| cron-validate | 1.4.5 | MIT |
| cross-spawn | 7.0.6 | MIT |
| crypt | 0.0.2 | BSD-3-Clause |
| css-select | 5.1.0 | BSD-2-Clause |
| css-what | 6.1.0 | BSD-2-Clause |
| cssstyle | 4.6.0 | MIT |
| custom-error-instance | 2.1.1 | ISC |
| dashdash | 1.14.1 | MIT |
| data-urls | 5.0.0 | MIT |
| data-view-buffer | 1.0.1 | MIT |
| data-view-buffer | 1.0.2 | MIT |
| data-view-byte-length | 1.0.1 | MIT |
| data-view-byte-length | 1.0.2 | MIT |
| data-view-byte-offset | 1.0.0 | MIT |
| data-view-byte-offset | 1.0.1 | MIT |
| debug | 2.6.9 | MIT |
| debug | 3.2.7 | MIT |
| debug | 4.3.4 | MIT |
| debug | 4.4.3 | MIT |
| decamelize | 1.2.0 | MIT |
| decimal.js | 10.6.0 | MIT |
| decompress-response | 6.0.0 | MIT |
| deep-extend | 0.6.0 | MIT |
| deepmerge | 4.3.1 | MIT |
| default-shell | 2.2.0 | MIT |
| define-data-property | 1.1.4 | MIT |
| define-lazy-prop | 2.0.0 | MIT |
| define-properties | 1.2.1 | MIT |
| delayed-stream | 1.0.0 | MIT |
| denque | 2.1.0 | Apache-2.0 |
| depd | 2.0.0 | MIT |
| destroy | 1.2.0 | MIT |
| detect-libc | 2.0.3 | Apache-2.0 |
| diff | 7.0.0 | BSD-3-Clause |
| digest-fetch | 1.3.0 | ISC |
| docx | 9.6.1 | MIT |
| dom-serializer | 2.0.0 | MIT |
| domelementtype | 2.3.0 | BSD-2-Clause |
| domhandler | 5.0.3 | BSD-2-Clause |
| dompurify | 3.3.3 | (MPL-2.0 OR Apache-2.0) |
| domutils | 3.1.0 | BSD-2-Clause |
| domutils | 3.2.2 | BSD-2-Clause |
| dotenv | 16.4.5 | BSD-2-Clause |
| dunder-proto | 1.0.1 | MIT |
| ecc-jsbn | 0.1.2 | MIT |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 |
| ee-first | 1.1.1 | MIT |
| elevenlabs | v0.5.0 | MIT |
| enabled | 2.0.0 | MIT |
| encode32 | 1.1.0 | MIT |
| encodeurl | 1.0.2 | MIT |
| encodeurl | 2.0.0 | MIT |
| encoding | 0.1.13 | MIT |
| encoding-sniffer | 0.2.0 | MIT |
| end-of-stream | 1.4.4 | MIT |
| entities | 4.5.0 | BSD-2-Clause |
| entities | 6.0.1 | BSD-2-Clause |
| es-abstract | 1.23.3 | MIT |
| es-abstract | 1.24.1 | MIT |
| es-aggregate-error | 1.0.13 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.1 | MIT |
| es-set-tostringtag | 2.0.3 | MIT |
| es-set-tostringtag | 2.1.0 | MIT |
| es-shim-unscopables | 1.0.2 | MIT |
| es-to-primitive | 1.2.1 | MIT |
| es-to-primitive | 1.3.0 | MIT |
| escape-html | 1.0.3 | MIT |
| etag | 1.8.1 | MIT |
| event-target-shim | 5.0.1 | MIT |
| eventemitter3 | 3.1.2 | MIT |
| eventemitter3 | 4.0.7 | MIT |
| events | 3.3.0 | MIT |
| eventsource | 3.0.7 | MIT |
| eventsource-parser | 3.0.6 | MIT |
| execa | 5.1.1 | MIT |
| expand-template | 2.0.3 | (MIT OR WTFPL) |
| expr-eval | 2.0.2 | MIT |
| express | 4.22.1 | MIT |
| express | 5.2.1 | MIT |
| express-rate-limit | 7.5.1 | MIT |
| extend | 3.0.2 | MIT |
| extract-json-from-string | 1.0.1 | MIT |
| extsprintf | 1.3.0 | MIT |
| extsprintf | 1.4.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-fifo | 1.3.2 | MIT |
| fast-levenshtein | 3.0.0 | MIT |
| fast-uri | 3.1.0 | BSD-3-Clause |
| fast-xml-parser | 4.5.0 | MIT |
| fastest-levenshtein | 1.0.16 | MIT |
| fd-slicer | 1.1.0 | MIT |
| fecha | 4.2.3 | MIT |
| file-type | 3.9.0 | MIT |
| finalhandler | 1.3.2 | MIT |
| finalhandler | 2.1.1 | MIT |
| find-replace | 3.0.0 | MIT |
| find-replace | 5.0.2 | MIT |
| fix-path | 4.0.0 | MIT |
| flat | 5.0.2 | BSD-3-Clause |
| flatbuffers | 1.12.0 | Apache-2.0 (from LICENSE file) |
| flatbuffers | 24.12.23 | Apache-2.0 |
| fn.name | 1.1.0 | MIT |
| follow-redirects | 1.15.6 | MIT |
| for-each | 0.3.3 | MIT |
| for-each | 0.3.5 | MIT |
| forever-agent | 0.6.1 | Apache-2.0 |
| form-data | 4.0.4 | MIT |
| form-data-encoder | 1.7.2 | MIT |
| formdata-node | 4.4.1 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 0.5.2 | MIT |
| fresh | 2.0.0 | MIT |
| fs-constants | 1.0.0 | MIT |
| fs.realpath | 1.0.0 | ISC |
| function-bind | 1.1.2 | MIT |
| function.prototype.name | 1.1.6 | MIT |
| function.prototype.name | 1.1.8 | MIT |
| functions-have-names | 1.2.3 | MIT |
| generate-function | 2.3.1 | MIT |
| get-intrinsic | 1.2.4 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| get-stream | 6.0.1 | MIT |
| get-symbol-description | 1.0.2 | MIT |
| get-symbol-description | 1.1.0 | MIT |
| getpass | 0.1.7 | MIT |
| github-from-package | 0.0.0 | MIT |
| glob | 7.2.3 | ISC |
| globalthis | 1.0.4 | MIT |
| gopd | 1.2.0 | MIT |
| graphql | 16.9.0 | MIT |
| guid-typescript | 1.0.9 | ISC |
| has-bigints | 1.0.2 | MIT |
| has-flag | 4.0.0 | MIT |
| has-property-descriptors | 1.0.2 | MIT |
| has-proto | 1.0.3 | MIT |
| has-proto | 1.2.0 | MIT |
| has-symbols | 1.0.3 | MIT |
| has-symbols | 1.1.0 | MIT |
| has-tostringtag | 1.0.2 | MIT |
| hash.js | 1.1.7 | MIT |
| hasown | 2.0.2 | MIT |
| html-encoding-sniffer | 4.0.0 | MIT |
| htmlparser2 | 9.1.0 | MIT |
| http_ece | 1.2.0 | MIT |
| http-errors | 2.0.0 | MIT |
| http-errors | 2.0.1 | MIT |
| http-proxy-agent | 7.0.2 | MIT |
| http-signature | 1.4.0 | MIT |
| https | 1.0.0 | ISC |
| https-proxy-agent | 7.0.4 | MIT |
| https-proxy-agent | 7.0.6 | MIT |
| human-interval | 2.0.1 | MIT |
| human-signals | 2.1.0 | Apache-2.0 |
| humanize-ms | 1.2.1 | MIT |
| iconv-lite | 0.4.24 | MIT |
| iconv-lite | 0.6.3 | MIT |
| iconv-lite | 0.7.1 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| image-size | 1.2.1 | MIT |
| immediate | 3.0.6 | MIT |
| inflight | 1.0.6 | ISC |
| inherits | 2.0.4 | ISC |
| ini | 1.3.8 | ISC |
| internal-slot | 1.0.7 | MIT |
| internal-slot | 1.1.0 | MIT |
| ip | 2.0.1 | MIT |
| ipaddr.js | 1.9.1 | MIT |
| is-any-array | 2.0.1 | MIT |
| is-array-buffer | 3.0.4 | MIT |
| is-array-buffer | 3.0.5 | MIT |
| is-arrayish | 0.3.2 | MIT |
| is-async-function | 2.0.0 | MIT |
| is-bigint | 1.0.4 | MIT |
| is-bigint | 1.1.0 | MIT |
| is-boolean-object | 1.1.2 | MIT |
| is-boolean-object | 1.2.2 | MIT |
| is-buffer | 1.1.6 | MIT |
| is-callable | 1.2.7 | MIT |
| is-data-view | 1.0.1 | MIT |
| is-data-view | 1.0.2 | MIT |
| is-date-object | 1.0.5 | MIT |
| is-date-object | 1.1.0 | MIT |
| is-docker | 2.2.1 | MIT |
| is-extglob | 1.0.0 | MIT |
| is-finalizationregistry | 1.1.1 | MIT |
| is-generator-function | 1.0.10 | MIT |
| is-glob | 2.0.1 | MIT |
| is-invalid-path | 0.1.0 | MIT |
| is-map | 2.0.3 | MIT |
| is-negative-zero | 2.0.3 | MIT |
| is-number-object | 1.0.7 | MIT |
| is-number-object | 1.1.1 | MIT |
| is-potential-custom-element-name | 1.0.1 | MIT |
| is-promise | 4.0.0 | MIT |
| is-property | 1.0.2 | MIT |
| is-regex | 1.1.4 | MIT |
| is-regex | 1.2.1 | MIT |
| is-set | 2.0.3 | MIT |
| is-shared-array-buffer | 1.0.3 | MIT |
| is-shared-array-buffer | 1.0.4 | MIT |
| is-stream | 2.0.1 | MIT |
| is-string | 1.0.7 | MIT |
| is-string | 1.1.1 | MIT |
| is-string-and-not-blank | 0.0.2 | MIT |
| is-string-blank | 1.0.1 | MIT |
| is-symbol | 1.0.4 | MIT |
| is-symbol | 1.1.1 | MIT |
| is-typed-array | 1.1.13 | MIT |
| is-typed-array | 1.1.15 | MIT |
| is-typedarray | 1.0.0 | MIT |
| is-valid-path | 0.1.1 | MIT |
| is-weakmap | 2.0.2 | MIT |
| is-weakref | 1.0.2 | MIT |
| is-weakref | 1.1.1 | MIT |
| is-weakset | 2.0.3 | MIT |
| is-wsl | 2.2.0 | MIT |
| isarray | 1.0.0 | MIT |
| isarray | 2.0.5 | MIT |
| isexe | 2.0.0 | ISC |
| isstream | 0.1.2 | MIT |
| joi | 17.13.0 | BSD-3-Clause |
| joi-password-complexity | 5.2.0 | MIT |
| jose | 6.1.3 | MIT |
| js-base64 | 3.7.2 | BSD-3-Clause |
| js-md4 | 0.3.2 | MIT |
| js-tiktoken | 1.0.11 | MIT |
| js-yaml | 4.1.0 | MIT |
| jsbi | 4.3.0 | Apache-2.0 |
| jsbn | 0.1.1 | MIT |
| jsdom | 26.1.0 | MIT |
| json-bignum | 0.0.3 | MIT |
| json-schema | 0.4.0 | (AFL-2.1 OR BSD-3-Clause) |
| json-schema-traverse | 1.0.0 | MIT |
| json-stringify-safe | 5.0.1 | ISC |
| json5 | 2.2.3 | MIT |
| jsonpointer | 5.0.1 | MIT |
| jsonrepair | 3.7.0 | ISC |
| jsonwebtoken | 9.0.2 | MIT |
| jsprim | 2.0.2 | MIT |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) |
| jwa | 1.4.1 | MIT |
| jwa | 2.0.0 | MIT |
| jws | 3.2.2 | MIT |
| jws | 4.0.0 | MIT |
| kuler | 2.0.0 | MIT |
| langchain | 0.1.36 | MIT |
| langchainhub | 0.0.8 | MIT |
| langsmith | 0.1.21 | MIT |
| lie | 3.3.0 | MIT |
| lil-http-terminator | 1.2.3 | BSD-3-Clause |
| lodash | 4.17.21 | MIT |
| lodash | 4.17.23 | MIT |
| lodash-es | 4.17.21 | MIT |
| lodash._baseiteratee | 4.7.0 | MIT |
| lodash._basetostring | 4.12.0 | MIT |
| lodash._baseuniq | 4.6.0 | MIT |
| lodash._createset | 4.0.3 | MIT |
| lodash._root | 3.0.1 | MIT |
| lodash._stringtopath | 4.8.0 | MIT |
| lodash.camelcase | 4.3.0 | MIT |
| lodash.includes | 4.3.0 | MIT |
| lodash.isboolean | 3.0.3 | MIT |
| lodash.isinteger | 4.0.4 | MIT |
| lodash.isnumber | 3.0.3 | MIT |
| lodash.isplainobject | 4.0.6 | MIT |
| lodash.isstring | 4.0.1 | MIT |
| lodash.once | 4.1.1 | MIT |
| lodash.uniqby | 4.5.0 | MIT |
| logform | 2.6.0 | MIT |
| long | 4.0.0 | Apache-2.0 |
| long | 5.2.3 | Apache-2.0 |
| lru-cache | 10.4.3 | ISC |
| lru-cache | 6.0.0 | ISC |
| lru-cache | 7.18.3 | ISC |
| lru-cache | 8.0.5 | ISC |
| marked | 15.0.12 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| md5 | 2.3.0 | BSD-3-Clause |
| media-typer | 0.3.0 | MIT |
| media-typer | 1.1.0 | MIT |
| merge-descriptors | 1.0.3 | MIT |
| merge-descriptors | 2.0.0 | MIT |
| merge-stream | 2.0.0 | MIT |
| methods | 1.1.2 | MIT |
| mime | 1.6.0 | MIT |
| mime | 3.0.0 | MIT |
| mime-db | 1.52.0 | MIT |
| mime-db | 1.54.0 | MIT |
| mime-types | 2.1.35 | MIT |
| mime-types | 3.0.2 | MIT |
| mimic-fn | 2.1.0 | MIT |
| mimic-response | 3.1.0 | MIT |
| minimalistic-assert | 1.0.1 | ISC |
| minimatch | 3.1.2 | ISC |
| minimist | 1.2.8 | MIT |
| mkdirp | 0.5.6 | MIT |
| mkdirp-classic | 0.5.3 | MIT |
| ml-array-mean | 1.1.6 | MIT |
| ml-array-sum | 1.1.6 | MIT |
| ml-distance | 4.0.1 | MIT |
| ml-distance-euclidean | 2.0.0 | MIT |
| ml-tree-similarity | 1.0.0 | MIT |
| moment | 2.30.1 | MIT |
| ms | 2.0.0 | MIT |
| ms | 2.1.2 | MIT |
| ms | 2.1.3 | MIT |
| mssql | 10.0.2 | MIT |
| multer | 2.0.0 | MIT |
| mustache | 4.2.0 | MIT |
| mysql2 | 3.10.3 | MIT |
| named-placeholders | 1.1.3 | MIT |
| nanoclone | 0.2.1 | MIT |
| nanoid | 5.1.7 | MIT |
| napi-build-utils | 1.0.2 | MIT |
| native-duplexpair | 1.0.0 | MIT |
| negotiator | 0.6.3 | MIT |
| negotiator | 1.0.0 | MIT |
| node-abi | 3.62.0 | MIT |
| node-abort-controller | 3.1.1 | MIT |
| node-addon-api | 6.1.0 | MIT |
| node-domexception | 1.0.0 | MIT |
| node-fetch | 2.7.0 | MIT |
| node-telegram-bot-api | 0.67.0 | MIT |
| npm-run-path | 4.0.1 | MIT |
| nth-check | 2.1.1 | BSD-2-Clause |
| num-sort | 2.1.0 | MIT |
| numbered | 1.1.0 | MIT |
| nwsapi | 2.2.23 | MIT |
| object-assign | 4.1.1 | MIT |
| object-inspect | 1.13.4 | MIT |
| object-keys | 1.1.1 | MIT |
| object.assign | 4.1.5 | MIT |
| object.assign | 4.1.7 | MIT |
| ollama | 0.6.3 | MIT |
| on-finished | 2.4.1 | MIT |
| once | 1.4.0 | ISC |
| one-time | 1.0.0 | MIT |
| onetime | 5.1.2 | MIT |
| onnx-proto | 4.0.4 | MIT |
| onnxruntime-common | 1.14.0 | MIT |
| onnxruntime-node | 1.14.0 | MIT |
| onnxruntime-web | 1.14.0 | MIT |
| open | 8.4.2 | MIT |
| openai | 4.39.1 | Apache-2.0 |
| openai | 4.95.1 | Apache-2.0 |
| openapi-types | 12.1.3 | MIT |
| own-keys | 1.0.1 | MIT |
| p-finally | 1.0.0 | MIT |
| p-is-promise | 3.0.0 | MIT |
| p-queue | 6.6.2 | MIT |
| p-retry | 4.6.2 | MIT |
| p-timeout | 3.2.0 | MIT |
| p-wait-for | 3.2.0 | MIT |
| pako | 1.0.11 | (MIT AND Zlib) |
| parse5 | 7.2.1 | MIT |
| parse5 | 7.3.0 | MIT |
| parse5-htmlparser2-tree-adapter | 7.1.0 | MIT |
| parse5-parser-stream | 7.1.2 | MIT |
| parseurl | 1.3.3 | MIT |
| path-is-absolute | 1.0.1 | MIT |
| path-key | 3.1.1 | MIT |
| path-to-regexp | 0.1.12 | MIT |
| path-to-regexp | 8.3.0 | MIT |
| pdf-lib | 1.17.1 | MIT |
| pend | 1.2.0 | MIT |
| performance-now | 2.1.0 | MIT |
| pg | 8.11.5 | MIT |
| pg-cloudflare | 1.1.1 | MIT |
| pg-connection-string | 2.6.4 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.6.2 | MIT |
| pg-protocol | 1.6.1 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| pkce-challenge | 5.0.1 | MIT |
| platform | 1.3.6 | MIT |
| pluralize | 8.0.0 | MIT |
| possible-typed-array-names | 1.0.0 | MIT |
| postgres-array | 2.0.0 | MIT |
| postgres-bytea | 1.0.0 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| posthog-node | 3.6.3 | MIT |
| pptxgenjs | 4.0.1 | MIT |
| prebuild-install | 7.1.2 | MIT |
| prisma | 5.3.1 | Apache-2.0 |
| process | 0.11.10 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| property-expr | 2.0.6 | MIT |
| protobufjs | 6.11.4 | BSD-3-Clause |
| proxy-addr | 2.0.7 | MIT |
| proxy-from-env | 1.1.0 | MIT |
| psl | 1.15.0 | MIT |
| pump | 2.0.1 | MIT |
| pump | 3.0.0 | MIT |
| punycode | 2.3.1 | MIT |
| qs | 6.11.2 | BSD-3-Clause |
| qs | 6.14.0 | BSD-3-Clause |
| qs | 6.14.2 | BSD-3-Clause |
| querystringify | 2.2.0 | MIT |
| queue | 6.0.2 | MIT |
| queue-tick | 1.0.1 | MIT |
| range-parser | 1.2.1 | MIT |
| raw-body | 2.5.3 | MIT |
| raw-body | 3.0.2 | MIT |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) |
| readable-stream | 2.3.8 | MIT |
| readable-stream | 3.6.2 | MIT |
| readable-stream | 4.5.2 | MIT |
| reflect-metadata | 0.2.2 | Apache-2.0 |
| reflect.getprototypeof | 1.0.10 | MIT |
| regenerator-runtime | 0.14.1 | MIT |
| regexp.prototype.flags | 1.5.2 | MIT |
| regexp.prototype.flags | 1.5.4 | MIT |
| request-promise-core | 1.1.3 | ISC |
| require-from-string | 2.0.2 | MIT |
| requires-port | 1.0.0 | MIT |
| retry | 0.13.1 | MIT |
| rfdc | 1.3.1 | MIT |
| router | 2.2.0 | MIT |
| rrweb-cssom | 0.8.0 | MIT |
| rusha | 0.8.14 | MIT |
| safe-array-concat | 1.1.2 | MIT |
| safe-array-concat | 1.1.3 | MIT |
| safe-buffer | 5.1.2 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safe-push-apply | 1.0.0 | MIT |
| safe-regex-test | 1.0.3 | MIT |
| safe-regex-test | 1.1.0 | MIT |
| safe-stable-stringify | 2.4.3 | MIT |
| safe-timers | 1.1.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| sax | 1.6.0 | BlueOak-1.0.0 |
| saxes | 6.0.0 | ISC |
| semver | 7.6.0 | ISC |
| send | 0.19.0 | MIT |
| send | 0.19.1 | MIT |
| send | 1.2.0 | MIT |
| seq-queue | 0.0.5 | MIT (from LICENSE file) |
| serve-static | 1.16.2 | MIT |
| serve-static | 2.2.0 | MIT |
| set-function-length | 1.2.2 | MIT |
| set-function-name | 2.0.2 | MIT |
| set-proto | 1.0.0 | MIT |
| setimmediate | 1.0.5 | MIT |
| setprototypeof | 1.2.0 | ISC |
| sharp | 0.32.6 | Apache-2.0 |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| shell-env | 4.0.1 | MIT |
| shell-path | 3.1.0 | MIT |
| side-channel | 1.0.6 | MIT |
| side-channel | 1.1.0 | MIT |
| side-channel-list | 1.0.0 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| signal-exit | 3.0.7 | ISC |
| simple-concat | 1.0.1 | MIT |
| simple-get | 4.0.1 | MIT |
| simple-swizzle | 0.2.2 | MIT |
| slugify | 1.6.6 | MIT |
| split2 | 4.2.0 | ISC |
| sprintf-js | 1.1.3 | BSD-3-Clause |
| sqlstring | 2.3.3 | MIT |
| sshpk | 1.18.0 | MIT |
| stack-trace | 0.0.10 | MIT |
| statuses | 2.0.1 | MIT |
| statuses | 2.0.2 | MIT |
| stealthy-require | 1.1.1 | ISC |
| stop-iteration-iterator | 1.1.0 | MIT |
| stoppable | 1.1.0 | MIT |
| stream-read-all | 3.0.1 | MIT |
| streamsearch | 1.1.0 | MIT |
| streamx | 2.16.1 | MIT |
| string_decoder | 1.1.1 | MIT |
| string_decoder | 1.3.0 | MIT |
| string.prototype.trim | 1.2.10 | MIT |
| string.prototype.trim | 1.2.9 | MIT |
| string.prototype.trimend | 1.0.8 | MIT |
| string.prototype.trimend | 1.0.9 | MIT |
| string.prototype.trimstart | 1.0.8 | MIT |
| strip-ansi | 7.1.2 | MIT |
| strip-final-newline | 2.0.0 | MIT |
| strip-json-comments | 2.0.1 | MIT |
| strnum | 1.0.5 | MIT |
| supports-color | 7.2.0 | MIT |
| swagger-autogen | 2.23.7 | MIT |
| swagger-ui-dist | 5.17.2 | Apache-2.0 |
| swagger-ui-express | 5.0.0 | MIT |
| symbol-tree | 3.2.4 | MIT |
| table-layout | 3.0.2 | MIT |
| table-layout | 4.1.1 | MIT |
| tar-fs | 2.1.1 | MIT |
| tar-fs | 3.0.6 | MIT |
| tar-stream | 2.2.0 | MIT |
| tar-stream | 3.1.7 | MIT |
| tarn | 3.0.2 | MIT |
| tedious | 16.7.1 | MIT |
| text-hex | 1.0.0 | MIT |
| tldts | 6.1.86 | MIT |
| tldts-core | 6.1.86 | MIT |
| toidentifier | 1.0.1 | MIT |
| toposort | 2.0.2 | MIT |
| tough-cookie | 4.1.4 | BSD-3-Clause |
| tough-cookie | 5.1.2 | BSD-3-Clause |
| tr46 | 0.0.3 | MIT |
| tr46 | 5.1.1 | MIT |
| triple-beam | 1.4.1 | MIT |
| truncate | 3.0.0 | MIT |
| tslib | 1.14.1 | 0BSD |
| tslib | 2.6.2 | 0BSD |
| tslib | 2.8.1 | 0BSD |
| tunnel-agent | 0.6.0 | Apache-2.0 |
| tweetnacl | 0.14.5 | Unlicense |
| type-is | 1.6.18 | MIT |
| type-is | 2.0.1 | MIT |
| typed-array-buffer | 1.0.2 | MIT |
| typed-array-buffer | 1.0.3 | MIT |
| typed-array-byte-length | 1.0.1 | MIT |
| typed-array-byte-length | 1.0.3 | MIT |
| typed-array-byte-offset | 1.0.2 | MIT |
| typed-array-byte-offset | 1.0.4 | MIT |
| typed-array-length | 1.0.6 | MIT |
| typed-array-length | 1.0.7 | MIT |
| typedarray | 0.0.6 | MIT |
| typical | 4.0.0 | MIT |
| typical | 7.1.1 | MIT |
| typical | 7.3.0 | MIT |
| unbox-primitive | 1.0.2 | MIT |
| unbox-primitive | 1.1.0 | MIT |
| undici | 6.21.1 | MIT |
| undici-types | 5.26.5 | MIT |
| undici-types | 6.19.8 | MIT |
| undici-types | 6.21.0 | MIT |
| undici-types | 7.18.2 | MIT |
| universalify | 0.2.0 | MIT |
| unpipe | 1.0.0 | MIT |
| url-join | 4.0.1 | MIT |
| url-parse | 1.5.10 | MIT |
| url-pattern | 1.0.3 | MIT |
| util-deprecate | 1.0.2 | MIT |
| utils-merge | 1.0.1 | MIT |
| uuid | 8.3.2 | MIT |
| uuid | 9.0.1 | MIT |
| uuid-apikey | 1.5.3 | MIT |
| vary | 1.1.2 | MIT |
| verror | 1.10.0 | MIT |
| w3c-xmlserializer | 5.0.0 | MIT |
| web-push | 3.6.7 | MPL-2.0 |
| web-streams-polyfill | 3.3.3 | MIT |
| web-streams-polyfill | 4.0.0-beta.3 | MIT |
| webidl-conversions | 3.0.1 | BSD-2-Clause |
| webidl-conversions | 7.0.0 | BSD-2-Clause |
| whatwg-encoding | 3.1.1 | MIT |
| whatwg-fetch | 3.6.20 | MIT |
| whatwg-mimetype | 4.0.0 | MIT |
| whatwg-url | 14.2.0 | MIT |
| whatwg-url | 5.0.0 | MIT |
| which | 2.0.2 | ISC |
| which-boxed-primitive | 1.0.2 | MIT |
| which-boxed-primitive | 1.1.1 | MIT |
| which-builtin-type | 1.2.1 | MIT |
| which-collection | 1.0.2 | MIT |
| which-typed-array | 1.1.15 | MIT |
| which-typed-array | 1.1.20 | MIT |
| winston | 3.13.0 | MIT |
| winston-transport | 4.7.0 | MIT |
| wordwrapjs | 5.1.0 | MIT |
| wrappy | 1.0.2 | ISC |
| ws | 7.5.10 | MIT |
| ws | 8.20.0 | MIT |
| xml | 1.0.1 | MIT |
| xml-js | 1.6.11 | MIT |
| xml-name-validator | 5.0.0 | Apache-2.0 |
| xmlchars | 2.2.0 | MIT |
| xtend | 4.0.2 | MIT |
| yallist | 4.0.0 | ISC |
| yaml | 2.4.2 | ISC |
| yauzl | 2.10.0 | MIT |
| yup | 0.32.9 | MIT |
| zod | 3.23.5 | MIT |
| zod | 4.1.13 | MIT |
| zod-to-json-schema | 3.23.0 | ISC |
| zod-to-json-schema | 3.25.0 | ISC |

## Packaged collector dependencies

445 packages (name and version).

| Package | Version | License |
| --- | --- | --- |
| @anthropic-ai/sdk | 0.9.1 | MIT |
| @colors/colors | 1.6.0 | MIT |
| @dabh/diagnostics | 2.0.8 | MIT |
| @fastify/busboy | 2.1.1 | MIT |
| @huggingface/jinja | 0.2.2 | MIT |
| @img/sharp-darwin-arm64 | 0.33.5 | Apache-2.0 |
| @img/sharp-libvips-darwin-arm64 | 1.0.4 | LGPL-3.0-or-later |
| @isaacs/cliui | 8.0.2 | ISC |
| @langchain/community | 0.0.57 | MIT |
| @langchain/community | 0.2.33 | MIT |
| @langchain/core | 0.1.63 | MIT |
| @langchain/core | 0.2.36 | MIT |
| @langchain/openai | 0.0.34 | MIT |
| @langchain/openai | 0.2.11 | MIT |
| @langchain/textsplitters | 0.0.3 | MIT |
| @mixmark-io/domino | 2.2.0 | BSD-2-Clause |
| @pkgjs/parseargs | 0.11.0 | MIT |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause |
| @protobufjs/codegen | 2.0.4 | BSD-3-Clause |
| @protobufjs/eventemitter | 1.1.0 | BSD-3-Clause |
| @protobufjs/fetch | 1.1.0 | BSD-3-Clause |
| @protobufjs/float | 1.0.2 | BSD-3-Clause |
| @protobufjs/inquire | 1.1.0 | BSD-3-Clause |
| @protobufjs/path | 1.1.2 | BSD-3-Clause |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause |
| @protobufjs/utf8 | 1.1.0 | BSD-3-Clause |
| @selderee/plugin-htmlparser2 | 0.11.0 | MIT |
| @so-ric/colorspace | 1.1.6 | MIT |
| @tokenizer/token | 0.3.0 | MIT |
| @types/mailparser | 3.4.6 | MIT |
| @xenova/transformers | 2.17.2 | Apache-2.0 |
| @xmldom/xmldom | 0.8.11 | MIT |
| @zone-eu/mailsplit | 5.4.7 | (MIT OR EUPL-1.1+) |
| abort-controller | 3.0.0 | MIT |
| accepts | 1.3.8 | MIT |
| acorn | 8.15.0 | MIT |
| adm-zip | 0.5.16 | MIT |
| agentkeepalive | 4.6.0 | MIT |
| ansi-regex | 5.0.1 | MIT |
| ansi-regex | 6.2.2 | MIT |
| ansi-styles | 4.3.0 | MIT |
| ansi-styles | 5.2.0 | MIT |
| argparse | 1.0.10 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| array-flatten | 1.1.1 | MIT |
| array-hyper-unique | 2.1.6 | ISC |
| async | 3.2.6 | MIT |
| asynckit | 0.4.0 | MIT |
| available-typed-arrays | 1.0.7 | MIT |
| b4a | 1.7.3 | Apache-2.0 |
| balanced-match | 1.0.2 | MIT |
| bare-events | 2.8.2 | Apache-2.0 |
| bare-fs | 4.5.1 | Apache-2.0 |
| bare-os | 3.6.2 | Apache-2.0 |
| bare-path | 3.0.0 | Apache-2.0 |
| bare-stream | 2.7.0 | Apache-2.0 |
| bare-url | 2.3.2 | Apache-2.0 |
| base-64 | 0.1.0 | MIT |
| base64-js | 1.5.1 | MIT |
| binary-extensions | 2.3.0 | MIT |
| binary-search | 1.3.6 | CC0-1.0 |
| bl | 1.2.3 | MIT |
| bl | 4.1.0 | MIT |
| bluebird | 3.4.7 | MIT |
| bluebird | 3.7.2 | MIT |
| bmp-js | 0.1.0 | MIT |
| body-parser | 1.20.4 | MIT |
| boolbase | 1.0.0 | ISC |
| brace-expansion | 2.0.2 | MIT |
| buffer | 5.7.1 | MIT |
| buffer | 6.0.3 | MIT |
| buffer-alloc | 1.2.0 | MIT |
| buffer-alloc-unsafe | 1.1.0 | MIT |
| buffer-crc32 | 0.2.13 | MIT |
| buffer-fill | 1.0.0 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind | 1.0.8 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| camelcase | 6.3.0 | MIT |
| charenc | 0.0.2 | BSD-3-Clause |
| chownr | 1.1.4 | ISC |
| color | 4.2.3 | MIT |
| color | 5.0.3 | MIT |
| color-convert | 2.0.1 | MIT |
| color-convert | 3.1.3 | MIT |
| color-name | 1.1.4 | MIT |
| color-name | 2.1.0 | MIT |
| color-string | 1.9.1 | MIT |
| color-string | 2.1.4 | MIT |
| combined-stream | 1.0.8 | MIT |
| commander | 10.0.1 | MIT |
| commander | 2.20.3 | MIT |
| content-disposition | 0.5.4 | MIT |
| content-type | 1.0.5 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.0.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| cors | 2.8.5 | MIT |
| crlf-normalize | 1.0.20 | ISC |
| cross-spawn | 7.0.6 | MIT |
| crypt | 0.0.2 | BSD-3-Clause |
| css-select | 5.2.2 | BSD-2-Clause |
| css-what | 6.2.2 | BSD-2-Clause |
| debug | 2.6.9 | MIT |
| decamelize | 1.2.0 | MIT |
| decompress | 4.2.1 | MIT |
| decompress-response | 6.0.0 | MIT |
| decompress-tar | 4.1.1 | MIT |
| decompress-tarbz2 | 4.1.1 | MIT |
| decompress-targz | 4.1.1 | MIT |
| decompress-unzip | 4.0.1 | MIT |
| deep-eql | 4.0.0 | MIT |
| deep-extend | 0.6.0 | MIT |
| deepmerge | 4.3.1 | MIT |
| default-shell | 2.2.0 | MIT |
| define-data-property | 1.1.4 | MIT |
| delayed-stream | 1.0.0 | MIT |
| depd | 2.0.0 | MIT |
| destroy | 1.2.0 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| digest-fetch | 1.3.0 | ISC |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause |
| dom-serializer | 2.0.0 | MIT |
| domelementtype | 2.3.0 | BSD-2-Clause |
| domhandler | 5.0.3 | BSD-2-Clause |
| domutils | 3.2.2 | BSD-2-Clause |
| dotenv | 16.6.1 | BSD-2-Clause |
| duck | 0.1.12 | BSD |
| dunder-proto | 1.0.1 | MIT |
| ee-first | 1.1.1 | MIT |
| emoji-regex | 8.0.0 | MIT |
| enabled | 2.0.0 | MIT |
| encodeurl | 1.0.2 | MIT |
| encodeurl | 2.0.0 | MIT |
| encoding-japanese | 2.2.0 | MIT |
| end-of-stream | 1.4.5 | MIT |
| entities | 4.5.0 | BSD-2-Clause |
| epub2 | 3.0.2 | ISC |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.1 | MIT |
| es-set-tostringtag | 2.1.0 | MIT |
| escape-html | 1.0.3 | MIT |
| etag | 1.8.1 | MIT |
| event-target-shim | 5.0.1 | MIT |
| eventemitter3 | 4.0.7 | MIT |
| events | 3.3.0 | MIT |
| events-universal | 1.0.1 | Apache-2.0 |
| execa | 5.1.1 | MIT |
| expand-template | 2.0.3 | (MIT OR WTFPL) |
| expr-eval | 2.0.2 | MIT |
| express | 4.22.1 | MIT |
| fast-fifo | 1.3.2 | MIT |
| fd-slicer | 1.1.0 | MIT |
| fecha | 4.2.3 | MIT |
| file-type | 16.5.4 | MIT |
| file-type | 3.9.0 | MIT |
| file-type | 5.2.0 | MIT |
| file-type | 6.2.0 | MIT |
| finalhandler | 1.3.2 | MIT |
| fix-path | 4.0.0 | MIT |
| flat | 5.0.2 | BSD-3-Clause |
| flatbuffers | 1.12.0 | Apache-2.0 (from LICENSE file) |
| fn.name | 1.1.0 | MIT |
| for-each | 0.3.5 | MIT |
| foreground-child | 3.3.1 | ISC |
| form-data | 4.0.5 | MIT |
| form-data-encoder | 1.7.2 | MIT |
| formdata-node | 4.4.1 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 0.5.2 | MIT |
| fs-constants | 1.0.0 | MIT |
| function-bind | 1.1.2 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| get-stream | 2.3.1 | MIT |
| get-stream | 6.0.1 | MIT |
| github-from-package | 0.0.0 | MIT |
| glob | 10.5.0 | ISC |
| gopd | 1.2.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| guid-typescript | 1.0.9 | ISC |
| has-property-descriptors | 1.0.2 | MIT |
| has-symbols | 1.1.0 | MIT |
| has-tostringtag | 1.0.2 | MIT |
| hasown | 2.0.2 | MIT |
| he | 1.2.0 | MIT |
| html-to-text | 9.0.5 | MIT |
| htmlparser2 | 8.0.2 | MIT |
| http-errors | 2.0.0 | MIT |
| http-errors | 2.0.1 | MIT |
| human-signals | 2.1.0 | Apache-2.0 |
| humanize-duration | 3.33.1 | Unlicense |
| humanize-ms | 1.2.1 | MIT |
| iconv-lite | 0.4.24 | MIT |
| iconv-lite | 0.6.3 | MIT |
| iconv-lite | 0.7.0 | MIT |
| idb-keyval | 6.2.2 | Apache-2.0 |
| ieee754 | 1.2.1 | BSD-3-Clause |
| ignore | 5.3.2 | MIT |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| ini | 1.3.8 | ISC |
| ipaddr.js | 1.9.1 | MIT |
| is-any-array | 2.0.1 | MIT |
| is-arrayish | 0.3.4 | MIT |
| is-buffer | 1.1.6 | MIT |
| is-callable | 1.2.7 | MIT |
| is-fullwidth-code-point | 3.0.0 | MIT |
| is-natural-number | 4.0.1 | MIT |
| is-stream | 1.1.0 | MIT |
| is-stream | 2.0.1 | MIT |
| is-typed-array | 1.1.15 | MIT |
| is-url | 1.2.4 | MIT |
| isarray | 1.0.0 | MIT |
| isarray | 2.0.5 | MIT |
| isexe | 2.0.0 | ISC |
| jackspeak | 3.4.3 | BlueOak-1.0.0 |
| jintr | 1.2.0 | MIT |
| js-tiktoken | 1.0.21 | MIT |
| js-yaml | 4.1.1 | MIT |
| jsonpointer | 5.0.1 | MIT |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) |
| kuler | 2.0.0 | MIT |
| langchain | 0.1.36 | MIT |
| langchain | 0.2.20 | MIT |
| langchainhub | 0.0.11 | MIT |
| langsmith | 0.1.68 | MIT |
| leac | 0.6.0 | MIT |
| libbase64 | 1.3.0 | MIT |
| libmime | 5.3.7 | MIT |
| libqp | 2.1.1 | MIT |
| lie | 3.3.0 | MIT |
| linkify-it | 5.0.0 | MIT |
| lodash | 4.17.21 | MIT |
| logform | 2.7.0 | MIT |
| long | 4.0.0 | Apache-2.0 |
| lop | 0.4.2 | BSD-2-Clause |
| lru-cache | 10.4.3 | ISC |
| mailparser | 3.9.0 | MIT |
| make-dir | 1.3.0 | MIT |
| mammoth | 1.11.0 | BSD-2-Clause |
| math-intrinsics | 1.1.0 | MIT |
| mbox-parser | 1.0.1 | MIT |
| md5 | 2.3.0 | BSD-3-Clause |
| media-typer | 0.3.0 | MIT |
| merge-descriptors | 1.0.3 | MIT |
| merge-stream | 2.0.0 | MIT |
| methods | 1.1.2 | MIT |
| mime | 1.6.0 | MIT |
| mime | 3.0.0 | MIT |
| mime-db | 1.52.0 | MIT |
| mime-types | 2.1.35 | MIT |
| mimic-fn | 2.1.0 | MIT |
| mimic-response | 3.1.0 | MIT |
| minimatch | 9.0.5 | ISC |
| minimist | 1.2.8 | MIT |
| minipass | 7.1.2 | ISC |
| mkdirp-classic | 0.5.3 | MIT |
| ml-array-mean | 1.1.6 | MIT |
| ml-array-sum | 1.1.6 | MIT |
| ml-distance | 4.0.1 | MIT |
| ml-distance-euclidean | 2.0.0 | MIT |
| ml-tree-similarity | 1.0.0 | MIT |
| moment | 2.30.1 | MIT |
| ms | 2.0.0 | MIT |
| ms | 2.1.3 | MIT |
| mustache | 4.2.0 | MIT |
| napi-build-utils | 2.0.0 | MIT |
| negotiator | 0.6.3 | MIT |
| node-abi | 3.85.0 | MIT |
| node-addon-api | 6.1.0 | MIT |
| node-domexception | 1.0.0 | MIT |
| node-ensure | 0.0.0 | MIT |
| node-fetch | 2.7.0 | MIT |
| node-html-parser | 6.1.13 | MIT |
| node-xlsx | 0.24.0 | Apache-2.0 |
| nodemailer | 7.0.10 | MIT-0 |
| npm-run-path | 4.0.1 | MIT |
| nth-check | 2.1.1 | BSD-2-Clause |
| num-sort | 2.1.0 | MIT |
| object-assign | 4.1.1 | MIT |
| object-inspect | 1.13.4 | MIT |
| officeparser | 4.2.0 | MIT |
| on-finished | 2.4.1 | MIT |
| once | 1.4.0 | ISC |
| one-time | 1.0.0 | MIT |
| onetime | 5.1.2 | MIT |
| onnx-proto | 4.0.4 | MIT |
| onnxruntime-common | 1.14.0 | MIT |
| onnxruntime-node | 1.14.0 | MIT |
| onnxruntime-web | 1.14.0 | MIT |
| openai | 4.104.0 | Apache-2.0 |
| openai | 4.95.1 | Apache-2.0 |
| openapi-types | 12.1.3 | MIT |
| opencollective-postinstall | 2.0.3 | MIT |
| option | 0.2.4 | BSD-2-Clause |
| p-finally | 1.0.0 | MIT |
| p-queue | 6.6.2 | MIT |
| p-retry | 4.6.2 | MIT |
| p-timeout | 3.2.0 | MIT |
| package-json-from-dist | 1.0.1 | BlueOak-1.0.0 |
| pako | 1.0.11 | (MIT AND Zlib) |
| parseley | 0.12.1 | MIT |
| parseurl | 1.3.3 | MIT |
| path-is-absolute | 1.0.1 | MIT |
| path-key | 3.1.1 | MIT |
| path-scurry | 1.11.1 | BlueOak-1.0.0 |
| path-to-regexp | 0.1.12 | MIT |
| pdf-parse | 1.1.4 | MIT |
| peberminta | 0.9.0 | MIT |
| peek-readable | 4.1.0 | MIT |
| pend | 1.2.0 | MIT |
| pify | 2.3.0 | MIT |
| pify | 3.0.0 | MIT |
| pinkie | 2.0.4 | MIT |
| pinkie-promise | 2.0.1 | MIT |
| platform | 1.3.6 | MIT |
| possible-typed-array-names | 1.1.0 | MIT |
| prebuild-install | 7.1.3 | MIT |
| process | 0.11.10 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| protobufjs | 6.11.4 | BSD-3-Clause |
| proxy-addr | 2.0.7 | MIT |
| pump | 3.0.3 | MIT |
| punycode.js | 2.3.1 | MIT |
| qs | 6.14.0 | BSD-3-Clause |
| range-parser | 1.2.1 | MIT |
| raw-body | 2.5.3 | MIT |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) |
| readable-stream | 2.3.8 | MIT |
| readable-stream | 3.6.2 | MIT |
| readable-stream | 4.7.0 | MIT |
| readable-web-to-node-stream | 3.0.4 | MIT |
| regenerator-runtime | 0.13.11 | MIT |
| retry | 0.13.1 | MIT |
| rimraf | 5.0.10 | ISC |
| safe-buffer | 5.1.2 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| sax | 1.4.3 | BlueOak-1.0.0 |
| seek-bzip | 1.0.6 | MIT |
| selderee | 0.11.0 | MIT |
| semver | 7.7.3 | ISC |
| send | 0.19.0 | MIT |
| send | 0.19.1 | MIT |
| serve-static | 1.16.2 | MIT |
| set-function-length | 1.2.2 | MIT |
| setimmediate | 1.0.5 | MIT |
| setprototypeof | 1.2.0 | ISC |
| sharp | 0.32.6 | Apache-2.0 |
| sharp | 0.33.5 | Apache-2.0 |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| shell-env | 4.0.1 | MIT |
| shell-path | 3.1.0 | MIT |
| side-channel | 1.1.0 | MIT |
| side-channel-list | 1.0.0 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| signal-exit | 3.0.7 | ISC |
| signal-exit | 4.1.0 | ISC |
| simple-concat | 1.0.1 | MIT |
| simple-get | 4.0.1 | MIT |
| simple-swizzle | 0.2.4 | MIT |
| slugify | 1.6.6 | MIT |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| stack-trace | 0.0.10 | MIT |
| statuses | 2.0.1 | MIT |
| statuses | 2.0.2 | MIT |
| streamx | 2.23.0 | MIT |
| string_decoder | 1.1.1 | MIT |
| string_decoder | 1.3.0 | MIT |
| string-width | 4.2.3 | MIT |
| strip-ansi | 6.0.1 | MIT |
| strip-ansi | 7.1.2 | MIT |
| strip-dirs | 2.1.0 | MIT |
| strip-final-newline | 2.0.0 | MIT |
| strip-json-comments | 2.0.1 | MIT |
| strtok3 | 6.3.0 | MIT |
| tar-fs | 2.1.4 | MIT |
| tar-fs | 3.1.1 | MIT |
| tar-stream | 1.6.2 | MIT |
| tar-stream | 2.2.0 | MIT |
| tar-stream | 3.1.7 | MIT |
| tesseract.js | 6.0.1 | Apache-2.0 |
| tesseract.js-core | 6.0.0 | Apache-2.0 |
| text-decoder | 1.2.3 | Apache-2.0 |
| text-hex | 1.0.0 | MIT |
| through | 2.3.8 | MIT |
| tlds | 1.261.0 | MIT |
| to-buffer | 1.2.2 | MIT |
| toidentifier | 1.0.1 | MIT |
| token-types | 4.2.1 | MIT |
| tr46 | 0.0.3 | MIT |
| triple-beam | 1.4.1 | MIT |
| ts-type | 3.0.1 | ISC |
| tslib | 2.8.1 | 0BSD |
| tunnel-agent | 0.6.0 | Apache-2.0 |
| turndown | 7.2.4 | MIT |
| type-detect | 4.1.0 | MIT |
| type-is | 1.6.18 | MIT |
| typed-array-buffer | 1.0.3 | MIT |
| typedarray-dts | 1.0.0 | MIT |
| uc.micro | 2.1.0 | MIT |
| unbzip2-stream | 1.4.3 | MIT |
| underscore | 1.13.7 | MIT |
| undici | 5.29.0 | MIT |
| undici-types | 5.26.5 | MIT |
| undici-types | 7.16.0 | MIT |
| unpipe | 1.0.0 | MIT |
| url-pattern | 1.0.3 | MIT |
| util-deprecate | 1.0.2 | MIT |
| utils-merge | 1.0.1 | MIT |
| uuid | 10.0.0 | MIT |
| uuid | 9.0.1 | MIT |
| vary | 1.1.2 | MIT |
| wasm-feature-detect | 1.8.0 | Apache-2.0 |
| wavefile | 11.0.0 | MIT |
| web-streams-polyfill | 3.3.3 | MIT |
| web-streams-polyfill | 4.0.0-beta.3 | MIT |
| webidl-conversions | 3.0.1 | BSD-2-Clause |
| whatwg-url | 5.0.0 | MIT |
| which | 2.0.2 | ISC |
| which-typed-array | 1.1.19 | MIT |
| winston | 3.18.3 | MIT |
| winston-transport | 4.9.0 | MIT |
| wrap-ansi | 7.0.0 | MIT |
| wrappy | 1.0.2 | ISC |
| ws | 8.14.2 | MIT |
| xlsx | 0.20.2 | Apache-2.0 |
| xml2js | 0.6.2 | MIT |
| xmlbuilder | 10.1.1 | MIT |
| xmlbuilder | 11.0.1 | MIT |
| xtend | 4.0.2 | MIT |
| yaml | 2.8.1 | ISC |
| yauzl | 2.10.0 | MIT |
| youtube-transcript-plus | 1.1.2 | MIT |
| youtubei.js | 9.4.0 | MIT |
| zlibjs | 0.3.1 | MIT |
| zod | 3.25.76 | MIT |
| zod-to-json-schema | 3.25.0 | ISC |

## Shell runtime dependencies (app.asar)

77 packages (name and version).

| Package | Version | License |
| --- | --- | --- |
| @napi-rs/canvas | 1.0.13 | MIT |
| @napi-rs/canvas-darwin-arm64 | 1.0.13 | MIT |
| @tesseract.js-data/chi_sim | 1.0.0 | MIT |
| @tesseract.js-data/eng | 1.0.0 | MIT |
| @xmldom/xmldom | 0.8.15 | MIT |
| argparse | 1.0.10 | MIT |
| base64-js | 1.5.1 | MIT |
| chokidar | 4.0.3 | MIT |
| commander | 7.2.0 | MIT |
| core-util-is | 1.0.3 | MIT |
| d3 | 7.9.0 | ISC |
| d3-array | 3.2.4 | ISC |
| d3-axis | 3.0.0 | ISC |
| d3-brush | 3.0.0 | ISC |
| d3-chord | 3.0.1 | ISC |
| d3-color | 3.1.0 | ISC |
| d3-contour | 4.0.2 | ISC |
| d3-delaunay | 6.0.4 | ISC |
| d3-dispatch | 3.0.1 | ISC |
| d3-drag | 3.0.0 | ISC |
| d3-dsv | 3.0.1 | ISC |
| d3-ease | 3.0.1 | BSD-3-Clause |
| d3-fetch | 3.0.1 | ISC |
| d3-force | 3.0.0 | ISC |
| d3-format | 3.1.2 | ISC |
| d3-geo | 3.1.1 | ISC |
| d3-hierarchy | 3.1.2 | ISC |
| d3-interpolate | 3.0.1 | ISC |
| d3-path | 3.1.0 | ISC |
| d3-polygon | 3.0.1 | ISC |
| d3-quadtree | 3.0.1 | ISC |
| d3-random | 3.0.1 | ISC |
| d3-scale | 4.0.2 | ISC |
| d3-scale-chromatic | 3.1.0 | ISC |
| d3-selection | 3.0.0 | ISC |
| d3-shape | 3.2.0 | ISC |
| d3-time | 3.1.0 | ISC |
| d3-time-format | 4.1.0 | ISC |
| d3-timer | 3.0.1 | ISC |
| d3-transition | 3.0.1 | ISC |
| d3-zoom | 3.0.0 | ISC |
| delaunator | 5.1.0 | ISC |
| dingbat-to-unicode | 1.0.2 | BSD-2-Clause |
| duck | 0.1.12 | BSD |
| fflate | 0.8.3 | MIT |
| graceful-fs | 4.2.11 | ISC |
| iconv-lite | 0.6.3 | MIT |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| internmap | 2.0.3 | ISC |
| isarray | 1.0.0 | MIT |
| jszip | 3.10.2 | (MIT OR GPL-3.0-or-later) |
| lie | 3.3.0 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| mammoth | 1.13.0 | BSD-2-Clause |
| node-int64 | 0.4.0 | MIT |
| option | 0.2.4 | BSD-2-Clause |
| pako | 1.0.11 | (MIT AND Zlib) |
| pdfjs-dist | 6.4.299 | Apache-2.0 |
| process-nextick-args | 2.0.1 | MIT |
| read-excel-file | 9.3.13 | MIT |
| readable-stream | 2.3.8 | MIT |
| readdirp | 4.1.2 | MIT |
| robust-predicates | 3.0.3 | Unlicense |
| rw | 1.3.3 | BSD-3-Clause |
| safe-buffer | 5.1.2 | MIT |
| safer-buffer | 2.1.2 | MIT |
| saxen | 11.2.0 | MIT |
| setimmediate | 1.0.5 | MIT |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| string_decoder | 1.1.1 | MIT |
| underscore | 1.13.8 | MIT |
| unzipper-esm | 0.13.3 | MIT |
| util-deprecate | 1.0.2 | MIT |
| worker-f | 0.1.21 | MIT |
| xlsx | 0.20.3 | Apache-2.0 |
| xmlbuilder | 10.1.1 | MIT |

## Shell development dependencies (not shipped)

373 packages (name and version).

| Package | Version | License |
| --- | --- | --- |
| @cacheable/memory | 2.2.0 | MIT |
| @cacheable/utils | 2.5.0 | MIT |
| @electron-internal/extract-zip | 1.0.7 | MIT |
| @electron/asar | 3.4.1 | MIT |
| @electron/fuses | 1.8.0 | MIT |
| @electron/get | 3.1.0 | MIT |
| @electron/get | 5.1.0 | MIT |
| @electron/notarize | 2.5.0 | MIT |
| @electron/osx-sign | 1.3.3 | BSD-2-Clause |
| @electron/rebuild | 4.2.1 | MIT |
| @electron/universal | 2.0.3 | MIT |
| @electron/windows-sign | 1.2.2 | BSD-2-Clause |
| @esbuild/darwin-arm64 | 0.28.2 | MIT |
| @eslint-community/eslint-utils | 4.10.1 | MIT |
| @eslint-community/regexpp | 4.12.2 | MIT |
| @eslint/config-array | 0.23.5 | Apache-2.0 |
| @eslint/config-helpers | 0.7.0 | Apache-2.0 |
| @eslint/core | 1.2.1 | Apache-2.0 |
| @eslint/js | 10.0.1 | MIT |
| @eslint/object-schema | 3.0.5 | Apache-2.0 |
| @eslint/plugin-kit | 0.7.3 | Apache-2.0 |
| @humanfs/core | 0.19.2 | Apache-2.0 |
| @humanfs/node | 0.16.8 | Apache-2.0 |
| @humanfs/types | 0.15.0 | Apache-2.0 |
| @humanwhocodes/module-importer | 1.0.1 | Apache-2.0 |
| @humanwhocodes/retry | 0.4.3 | Apache-2.0 |
| @isaacs/fs-minipass | 4.0.1 | ISC |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @keyv/bigmap | 1.3.1 | MIT |
| @keyv/serialize | 1.1.1 | MIT |
| @malept/cross-spawn-promise | 2.0.0 | Apache-2.0 |
| @malept/flatpak-bundler | 0.4.0 | MIT |
| @noble/hashes | 1.8.0 | MIT |
| @oxc-project/types | 0.155.0 | MIT |
| @peculiar/asn1-schema | 2.11.1 | MIT |
| @peculiar/json-schema | 1.1.12 | MIT |
| @peculiar/utils | 2.0.3 | MIT |
| @peculiar/webcrypto | 1.7.2 | MIT |
| @playwright/test | 1.63.0 | Apache-2.0 |
| @rolldown/binding-darwin-arm64 | 1.2.15 | MIT |
| @rolldown/pluginutils | 1.0.1 | MIT |
| @sindresorhus/is | 4.6.0 | MIT |
| @szmarczak/http-timer | 4.0.6 | MIT |
| @types/cacheable-request | 6.0.3 | MIT |
| @types/chai | 5.2.3 | MIT |
| @types/debug | 4.1.13 | MIT |
| @types/deep-eql | 4.0.2 | MIT |
| @types/esrecurse | 4.3.1 | MIT |
| @types/estree | 1.0.10 | MIT |
| @types/fs-extra | 9.0.13 | MIT |
| @types/http-cache-semantics | 4.2.0 | MIT |
| @types/json-schema | 7.0.15 | MIT |
| @types/keyv | 3.1.4 | MIT |
| @types/ms | 2.1.0 | MIT |
| @types/node | 22.20.5 | MIT |
| @types/node | 24.19.2 | MIT |
| @types/responselike | 1.0.3 | MIT |
| @typescript-eslint/eslint-plugin | 8.71.2 | MIT |
| @typescript-eslint/parser | 8.71.2 | MIT |
| @typescript-eslint/project-service | 8.71.2 | MIT |
| @typescript-eslint/scope-manager | 8.71.2 | MIT |
| @typescript-eslint/tsconfig-utils | 8.71.2 | MIT |
| @typescript-eslint/type-utils | 8.71.2 | MIT |
| @typescript-eslint/types | 8.71.2 | MIT |
| @typescript-eslint/typescript-estree | 8.71.2 | MIT |
| @typescript-eslint/utils | 8.71.2 | MIT |
| @typescript-eslint/visitor-keys | 8.71.2 | MIT |
| @vitest/mocker | 5.0.5 | MIT |
| @vitest/spy | 5.0.5 | MIT |
| abbrev | 4.0.0 | ISC |
| acorn | 8.19.0 | MIT |
| acorn-jsx | 5.3.2 | MIT |
| agent-base | 7.1.4 | MIT |
| ajv | 6.15.0 | MIT |
| ajv | 8.20.0 | MIT |
| ansi-regex | 5.0.1 | MIT |
| ansi-styles | 4.3.0 | MIT |
| app-builder-lib | 26.17.0 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| asn1js | 3.1.0 | BSD-3-Clause |
| assertion-error | 2.0.1 | MIT |
| async | 3.2.6 | MIT |
| async-exit-hook | 2.0.1 | MIT |
| asynckit | 0.4.0 | MIT |
| at-least-node | 1.0.0 | ISC |
| aws4 | 1.13.2 | MIT |
| balanced-match | 1.0.2 | MIT |
| balanced-match | 4.0.4 | MIT |
| bluebird | 3.7.2 | MIT |
| boolean | 3.2.0 | MIT |
| brace-expansion | 1.1.21 | MIT |
| brace-expansion | 2.1.7 | MIT |
| brace-expansion | 5.0.12 | MIT |
| buffer-from | 1.1.2 | MIT |
| builder-util | 26.16.0 | MIT |
| builder-util-runtime | 9.7.0 | MIT |
| bytestreamjs | 2.0.1 | BSD-3-Clause |
| cacheable | 2.5.0 | MIT |
| cacheable-lookup | 5.0.4 | MIT |
| cacheable-request | 7.0.4 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| chai | 6.3.0 | MIT |
| chalk | 4.1.2 | MIT |
| chownr | 3.0.0 | BlueOak-1.0.0 |
| chromium-pickle-js | 0.2.0 | MIT |
| ci-info | 4.3.1 | MIT |
| ci-info | 4.4.0 | MIT |
| cliui | 8.0.1 | ISC |
| clone-response | 1.0.3 | MIT |
| color-convert | 2.0.1 | MIT |
| color-name | 1.1.4 | MIT |
| combined-stream | 1.0.8 | MIT |
| commander | 5.1.0 | MIT |
| commander | 9.5.0 | MIT |
| compare-version | 0.1.2 | MIT |
| concat-map | 0.0.1 | MIT |
| cross-dirname | 0.1.0 | MIT |
| cross-spawn | 7.0.6 | MIT |
| debug | 4.4.3 | MIT |
| decompress-response | 6.0.0 | MIT |
| deep-is | 0.1.4 | MIT |
| defer-to-connect | 2.0.1 | MIT |
| define-data-property | 1.1.4 | MIT |
| define-properties | 1.2.1 | MIT |
| delayed-stream | 1.0.0 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| detect-node | 2.1.0 | MIT |
| dir-compare | 4.2.0 | MIT |
| dmg-builder | 26.17.0 | MIT |
| dotenv | 16.6.1 | BSD-2-Clause |
| dotenv-expand | 11.0.7 | BSD-2-Clause |
| dunder-proto | 1.0.1 | MIT |
| duplexer2 | 0.1.4 | BSD-3-Clause |
| ejs | 3.1.10 | Apache-2.0 |
| electron | 44.10.0 | MIT |
| electron-builder | 26.17.0 | MIT |
| electron-builder-squirrel-windows | 26.17.0 | MIT |
| electron-publish | 26.16.0 | MIT |
| electron-winstaller | 5.4.0 | MIT |
| emoji-regex | 8.0.0 | MIT |
| end-of-stream | 1.4.5 | MIT |
| env-paths | 2.2.1 | MIT |
| env-paths | 3.0.0 | MIT |
| err-code | 2.0.3 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-module-lexer | 2.3.2 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| es-set-tostringtag | 2.1.0 | MIT |
| es6-error | 4.1.1 | MIT |
| esbuild | 0.28.2 | MIT |
| escalade | 3.2.0 | MIT |
| escape-string-regexp | 4.0.0 | MIT |
| eslint | 10.12.0 | MIT |
| eslint-scope | 9.1.2 | BSD-2-Clause |
| eslint-visitor-keys | 3.4.3 | Apache-2.0 |
| eslint-visitor-keys | 5.0.1 | Apache-2.0 |
| espree | 11.2.0 | BSD-2-Clause |
| esquery | 1.7.0 | BSD-3-Clause |
| esrecurse | 4.3.0 | BSD-2-Clause |
| estraverse | 5.3.0 | BSD-2-Clause |
| estree-walker | 3.0.3 | MIT |
| esutils | 2.0.3 | BSD-2-Clause |
| expect-type | 1.4.0 | Apache-2.0 |
| exponential-backoff | 3.1.3 | Apache-2.0 |
| fast-deep-equal | 3.1.3 | MIT |
| fast-json-stable-stringify | 2.1.0 | MIT |
| fast-levenshtein | 2.0.6 | MIT |
| fast-uri | 3.1.9 | BSD-3-Clause |
| fdir | 6.5.0 | MIT |
| file-entry-cache | 11.1.5 | MIT |
| filelist | 1.0.6 | Apache-2.0 |
| find-up | 5.0.0 | MIT |
| flat-cache | 6.1.23 | MIT |
| flatted | 3.4.4 | ISC |
| form-data | 4.0.6 | MIT |
| fs-extra | 10.1.0 | MIT |
| fs-extra | 11.3.1 | MIT |
| fs-extra | 11.4.1 | MIT |
| fs-extra | 7.0.1 | MIT |
| fs-extra | 8.1.0 | MIT |
| fs-extra | 9.1.0 | MIT |
| fs.realpath | 1.0.0 | ISC |
| fsevents | 2.3.3 | MIT |
| function-bind | 1.1.2 | MIT |
| get-caller-file | 2.0.5 | ISC |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| get-stream | 5.2.0 | MIT |
| glob | 7.2.3 | ISC |
| glob-parent | 6.0.2 | ISC |
| global-agent | 3.0.0 | BSD-3-Clause |
| globalthis | 1.0.4 | MIT |
| gopd | 1.2.0 | MIT |
| got | 11.8.6 | MIT |
| has-flag | 4.0.0 | MIT |
| has-property-descriptors | 1.0.2 | MIT |
| has-symbols | 1.1.0 | MIT |
| has-tostringtag | 1.0.2 | MIT |
| hashery | 1.5.1 | MIT |
| hasown | 2.0.4 | MIT |
| hookified | 1.15.1 | MIT |
| hookified | 2.2.0 | MIT |
| hosted-git-info | 4.1.0 | ISC |
| http-cache-semantics | 4.3.0 | BSD-2-Clause |
| http-proxy-agent | 7.0.2 | MIT |
| http2-wrapper | 1.0.3 | MIT |
| https-proxy-agent | 7.0.6 | MIT |
| ignore | 5.3.2 | MIT |
| ignore | 7.0.14 | MIT |
| imurmurhash | 0.1.4 | MIT |
| inflight | 1.0.6 | ISC |
| is-extglob | 2.1.1 | MIT |
| is-fullwidth-code-point | 3.0.0 | MIT |
| is-glob | 4.0.3 | MIT |
| isbinaryfile | 4.0.10 | MIT |
| isbinaryfile | 5.0.7 | MIT |
| isexe | 2.0.0 | ISC |
| isexe | 3.1.5 | BlueOak-1.0.0 |
| isexe | 4.0.0 | BlueOak-1.0.0 |
| jake | 10.9.4 | Apache-2.0 |
| jiti | 2.7.0 | MIT |
| js-yaml | 4.3.2 | MIT |
| json-buffer | 3.0.1 | MIT |
| json-schema-traverse | 0.4.1 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| json-stable-stringify-without-jsonify | 1.0.1 | MIT |
| json-stringify-safe | 5.0.1 | ISC |
| json5 | 2.2.3 | MIT |
| jsonfile | 4.0.0 | MIT |
| jsonfile | 6.2.1 | MIT |
| keyv | 4.5.4 | MIT |
| keyv | 5.6.0 | MIT |
| lazy-val | 1.0.5 | MIT |
| levn | 0.4.1 | MIT |
| lightningcss | 1.33.0 | MPL-2.0 |
| lightningcss-darwin-arm64 | 1.33.0 | MPL-2.0 |
| locate-path | 6.0.0 | MIT |
| lodash | 4.18.1 | MIT |
| lowercase-keys | 2.0.0 | MIT |
| lru-cache | 6.0.0 | ISC |
| magic-string | 1.4.5 | MIT |
| matcher | 3.0.0 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| mime | 2.6.0 | MIT |
| mime-db | 1.52.0 | MIT |
| mime-types | 2.1.35 | MIT |
| mimic-response | 1.0.1 | MIT |
| mimic-response | 3.1.0 | MIT |
| minimatch | 10.2.6 | BlueOak-1.0.0 |
| minimatch | 3.1.5 | ISC |
| minimatch | 5.1.9 | ISC |
| minimatch | 9.0.9 | ISC |
| minimist | 1.2.8 | MIT |
| minipass | 7.1.3 | BlueOak-1.0.0 |
| minizlib | 3.1.0 | MIT |
| mkdirp | 0.5.6 | MIT |
| ms | 2.1.3 | MIT |
| nanoid | 3.3.20 | MIT |
| natural-compare | 1.4.0 | MIT |
| node-abi | 4.40.0 | MIT |
| node-api-version | 0.2.1 | MIT |
| node-gyp | 12.4.0 | MIT |
| nopt | 9.0.0 | ISC |
| normalize-url | 6.1.0 | MIT |
| object-keys | 1.1.1 | MIT |
| obug | 3.0.0 | MIT |
| once | 1.4.0 | ISC |
| optionator | 0.9.4 | MIT |
| p-cancelable | 2.1.1 | MIT |
| p-limit | 3.1.0 | MIT |
| p-locate | 5.0.0 | MIT |
| path-exists | 4.0.0 | MIT |
| path-is-absolute | 1.0.1 | MIT |
| path-key | 3.1.1 | MIT |
| pe-library | 0.4.1 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 4.0.7 | MIT |
| pkijs | 3.4.3 | BSD-3-Clause |
| playwright | 1.63.0 | Apache-2.0 |
| playwright-core | 1.63.0 | Apache-2.0 |
| plist | 3.1.0 | MIT |
| postcss | 8.5.32 | MIT |
| postject | 1.0.0-alpha.6 | MIT |
| prelude-ls | 1.2.1 | MIT |
| prettier | 3.9.10 | MIT |
| proc-log | 6.1.0 | ISC |
| progress | 2.0.3 | MIT |
| promise-retry | 2.0.1 | MIT |
| proper-lockfile | 4.1.2 | MIT |
| pump | 3.0.4 | MIT |
| punycode | 2.3.1 | MIT |
| pvtsutils | 1.3.6 | MIT |
| pvutils | 1.2.0 | MIT |
| qified | 0.10.1 | MIT |
| quick-lru | 5.1.1 | MIT |
| read-binary-file-arch | 1.0.6 | MIT |
| require-directory | 2.1.1 | MIT |
| require-from-string | 2.0.2 | MIT |
| resedit | 1.7.2 | MIT |
| resolve-alpn | 1.2.1 | MIT |
| responselike | 2.0.1 | MIT |
| retry | 0.12.0 | MIT |
| rimraf | 2.6.3 | ISC |
| roarr | 2.15.4 | BSD-3-Clause |
| rolldown | 1.2.15 | MIT |
| sanitize-filename | 1.6.4 | WTFPL OR ISC |
| sax | 1.6.1 | BlueOak-1.0.0 |
| semver | 5.7.2 | ISC |
| semver | 6.3.1 | ISC |
| semver | 7.7.4 | ISC |
| semver | 7.8.5 | ISC |
| semver-compare | 1.0.0 | MIT |
| serialize-error | 7.0.1 | MIT |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| signal-exit | 3.0.7 | ISC |
| simple-update-notifier | 2.0.0 | MIT |
| source-map | 0.6.1 | BSD-3-Clause |
| source-map-js | 1.2.2 | BSD-3-Clause |
| source-map-support | 0.5.21 | MIT |
| sprintf-js | 1.1.3 | BSD-3-Clause |
| stat-mode | 1.0.0 | MIT |
| std-env | 4.3.0 | MIT |
| string-width | 4.2.3 | MIT |
| strip-ansi | 6.0.1 | MIT |
| sumchecker | 3.0.1 | Apache-2.0 |
| supports-color | 7.2.0 | MIT |
| tar | 7.5.22 | BlueOak-1.0.0 |
| temp | 0.9.4 | MIT |
| temp-file | 3.4.0 | MIT |
| tiny-async-pool | 1.3.0 | MIT |
| tinybench | 6.2.2 | MIT |
| tinyexec | 1.3.1 | MIT |
| tinyglobby | 0.2.17 | MIT |
| tmp | 0.2.7 | MIT |
| tmp-promise | 3.0.3 | MIT |
| truncate-utf8-bytes | 1.0.2 | WTFPL |
| ts-api-utils | 2.5.0 | MIT |
| tslib | 2.8.1 | 0BSD |
| tsx | 4.23.15 | MIT |
| type-check | 0.4.0 | MIT |
| type-fest | 0.13.1 | (MIT OR CC0-1.0) |
| typescript | 6.0.3 | Apache-2.0 |
| typescript-eslint | 8.71.2 | MIT |
| undici | 6.29.1 | MIT |
| undici | 7.30.1 | MIT |
| undici-types | 6.21.0 | MIT |
| undici-types | 7.24.6 | MIT |
| universalify | 0.1.2 | MIT |
| universalify | 2.0.1 | MIT |
| unzipper | 0.12.5 | MIT |
| uri-js | 4.4.1 | BSD-2-Clause |
| utf8-byte-length | 1.0.5 | (WTFPL OR MIT) |
| vite | 8.3.5 | MIT |
| vitest | 5.0.5 | MIT |
| webcrypto-core | 1.9.2 | MIT |
| which | 2.0.2 | ISC |
| which | 5.0.0 | ISC |
| which | 6.0.1 | ISC |
| why-is-node-running | 3.2.1 | MIT |
| word-wrap | 1.2.5 | MIT |
| wrap-ansi | 7.0.0 | MIT |
| wrappy | 1.0.2 | ISC |
| xmlbuilder | 15.1.1 | MIT |
| y18n | 5.0.8 | ISC |
| yallist | 4.0.0 | ISC |
| yallist | 5.0.0 | BlueOak-1.0.0 |
| yargs | 17.7.3 | MIT |
| yargs-parser | 21.1.1 | ISC |
| yocto-queue | 0.1.0 | MIT |
