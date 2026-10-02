// A one-time forced reimport of a sandbox's scripts after its Library was copied from another project path
// (machine/sandboxes.ts). The copy keeps stale script-to-class mappings: on LothDesktop's first machine sandboxes
// (2026-09-28) URP renderer features loaded as missing, the player build crashed in the shader step and the FMOD
// settings were dropped, until every script under Assets was reimported once. Unity has no command-line switch
// for that, so the pool drops this editor script into the sandbox: at the first editor start it reimports the
// scripts, then deletes itself. Its folder is excluded from git, so it can never be committed.
import fs from 'node:fs';
import path from 'node:path';

/** The folder the script lives in, relative to the project; it deletes itself once done. */
export const REIMPORT_FOLDER = 'Assets/__FFFactoryReimport';

export const REIMPORT_SCRIPT = `// Written by SketchUp Factory after it copied a warm Library into this sandbox (machine/scriptReimport.ts).
// A Library copied from another project path keeps stale script-to-class mappings, so at the first editor
// start every script under Assets is reimported once; then this folder deletes itself. Never commit it.
#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;

namespace FFFactory
{
    [InitializeOnLoad]
    static class ScriptReimportAfterLibraryCopy
    {
        const string Folder = "${REIMPORT_FOLDER}";

        static ScriptReimportAfterLibraryCopy()
        {
            EditorApplication.delayCall += Run;
        }

        static void Run()
        {
            if (!AssetDatabase.IsValidFolder(Folder) || EditorApplication.isPlayingOrWillChangePlaymode) return;
            var paths = new System.Collections.Generic.List<string>();
            foreach (var pattern in new[] { "*.cs", "*.asmdef", "*.asmref" })
                foreach (var f in Directory.GetFiles("Assets", pattern, SearchOption.AllDirectories))
                {
                    var p = f.Replace('\\\\', '/');
                    if (!p.StartsWith(Folder)) paths.Add(p);
                }
            UnityEngine.Debug.Log("[SketchUp Factory] This sandbox's Library was copied from another project: reimporting its " + paths.Count + " scripts once.");
            AssetDatabase.StartAssetEditing();
            try
            {
                foreach (var p in paths) AssetDatabase.ImportAsset(p, ImportAssetOptions.ForceUpdate);
            }
            finally
            {
                AssetDatabase.StopAssetEditing();
            }
            AssetDatabase.DeleteAsset(Folder);
            AssetDatabase.Refresh();
            UnityEngine.Debug.Log("[SketchUp Factory] Script reimport done.");
        }
    }
}
#endif
`;

/** The git exclude line that keeps the folder (and the .meta files Unity makes for it) out of every commit. */
export const REIMPORT_EXCLUDE = `/${REIMPORT_FOLDER}*`;

/**
 * Arm the one-time script reimport in `project` (a sandbox whose Library was just copied): write the editor
 * script, and exclude its folder in the repo's `info/exclude` (`gitCommonDir`, shared by every worktree).
 */
export function armScriptReimport(project: string, gitCommonDir: string) {
  const dir = path.join(project, ...REIMPORT_FOLDER.split('/'), 'Editor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ScriptReimportAfterLibraryCopy.cs'), REIMPORT_SCRIPT);
  const exclude = path.join(gitCommonDir, 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(exclude, 'utf8');
  } catch {
    // no exclude file yet
  }
  if (!text.split(/\r?\n/).includes(REIMPORT_EXCLUDE)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}# SketchUp Factory: a sandbox's one-time script reimport after a Library copy (machine/scriptReimport.ts)\n${REIMPORT_EXCLUDE}\n`);
  }
}
