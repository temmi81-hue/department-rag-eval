import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { FileBlob, PresentationFile } = await import(pathToFileURL('C:/Users/POSCOFUTUREM/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs').href);

const workspaceDir = 'C:/Users/POSCOFUTUREM/Desktop/department-rag-eval';
const skillDir = 'C:/Users/POSCOFUTUREM/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.12148/skills/Presentations';
const runtimePython = 'C:/Users/POSCOFUTUREM/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const sourcePath = path.join(workspaceDir, 'Claude outputs/260916_AI활용_업무지침네비게이터_수정본.pptx');
const candidatePath = path.join(workspaceDir, '.ppt-build/candidate.pptx');
const finalPath = path.join(workspaceDir, '발표자료_최종/업무지침_네비게이터_서버구현결과_발표자료_v2.pptx');

await fs.mkdir(path.dirname(candidatePath), { recursive: true });
await fs.mkdir(path.dirname(finalPath), { recursive: true });
const presentation = await PresentationFile.importPptx(await FileBlob.load(sourcePath));
const snapshot = await presentation.inspect({ kind: 'slide,textbox,shape,image,notes,layout', maxChars: 12000 });
await fs.writeFile(path.join(workspaceDir, '.ppt-build/inspection.ndjson'), snapshot.ndjson ?? String(snapshot));
await (await PresentationFile.exportPptx(presentation)).save(candidatePath);

const { finalizePresentation } = await import(pathToFileURL(path.join(skillDir, 'container_tools/artifact_tool_utils.mjs')).href);
const result = await finalizePresentation({
  workspaceDir,
  candidatePath,
  finalPath,
  pythonExecutable: runtimePython,
  integrityValidatorPath: path.join(skillDir, 'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath: path.join(skillDir, 'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs: ['--expected-slide-size-emu', '12192000,6858000', '--validate-bullet-geometry', '--validate-heading-fit'],
  fontPolicy: { basis: 'design', families: ['Calibri', 'Malgun Gothic'] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(workspaceDir, '.ppt-build/validation.json'),
});
console.log(JSON.stringify(result));
