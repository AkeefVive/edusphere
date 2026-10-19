# EduSphere website — how to publish on GitHub Pages

1. Sign in at github.com and click **New repository**. Name it (e.g. `edusphere`), set it to **Public**, and create it.
2. On the new repository page click **uploading an existing file**. Drag in **everything inside this folder** (`index.html`, `support.js`, `quest-scene.js`, `.nojekyll`, and the `assets` and `uploads` folders). Click **Commit changes**.
   - If `.nojekyll` doesn't appear when dragging (hidden file), it's optional — the site works without it.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
4. Wait 1–2 minutes. The link appears at the top of the Pages screen:
   `https://<your-username>.github.io/<repository-name>/`

## Updating later
Upload the changed files to the same repository (same names, same folders) and commit. The live site refreshes within a couple of minutes.

## Notes
- Keep the folder structure exactly as it is; the page looks for `assets/…`, `uploads/Quest3.glb` and `quest-scene.js` next to `index.html`.
- The 3D libraries and fonts load from public CDNs, so visitors need an internet connection.
- Opening `index.html` by double-clicking on your computer may not load the 3D model (browsers block local file loading). It works once it's on GitHub Pages or any web server.
