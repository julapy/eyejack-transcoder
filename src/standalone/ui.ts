// Standalone harness UI — a minimal plain-DOM surface for the transcoder: drag/drop +
// file picker, a Transcode button, a live progress bar, an on-screen log console, and
// an output preview. Type + alpha are auto-detected; for explicit options use the
// window API. Framework-free (no Vue/React) so it stays a thin dev/test tool.

export interface HarnessUI {
  onStart(cb: (files: File[]) => void): void;
  setStatus(msg: string, isError?: boolean): void;
  setProgress(percent: number): void;
  appendLog(line: string): void;
  clearLog(): void;
  showOutput(url: string, kind: 'video' | 'image', downloadName: string): void;
  setFiles(files: File[]): void;
}

const css = `
  #app { display:flex; flex-direction:column; height:100vh; color:#1d1d1f; }
  .tc-header { padding:12px 16px; background:#111; color:#fff; font-weight:600; }
  .tc-header small { font-weight:400; opacity:.7; margin-left:8px; }
  .tc-body { display:grid; grid-template-columns:380px 1fr; flex:1; min-height:0; }
  .tc-left { padding:16px; border-right:1px solid #e5e5e7; overflow:auto; }
  .tc-right { display:flex; flex-direction:column; min-height:0; }
  .tc-drop { border:2px dashed #c7c7cc; border-radius:10px; padding:28px 16px; text-align:center;
             color:#6e6e73; cursor:pointer; transition:.15s; }
  .tc-drop.drag { border-color:#0071e3; background:#f0f7ff; color:#0071e3; }
  .tc-files { margin:12px 0; font-size:13px; color:#1d1d1f; word-break:break-all; }
  .tc-start { font-size:14px; padding:6px 10px; border-radius:8px; }
  .tc-start { background:#0071e3; color:#fff; border:0; cursor:pointer; width:100%; padding:11px; margin-top:8px; font-weight:600; }
  .tc-start:disabled { background:#c7c7cc; cursor:default; }
  .tc-status { margin-top:12px; font-size:13px; min-height:18px; }
  .tc-status.err { color:#d70015; white-space:pre-wrap; }
  .tc-bar { height:8px; background:#e5e5e7; border-radius:4px; overflow:hidden; margin-top:8px; }
  .tc-bar > div { height:100%; width:0; background:#0071e3; transition:width .1s; }
  .tc-out { padding:16px; border-bottom:1px solid #e5e5e7; }
  .tc-out video, .tc-out img { max-width:100%; max-height:340px; background:#000; border-radius:8px; }
  .tc-log { flex:1; margin:0; padding:12px 16px; overflow:auto; background:#0b0b0c; color:#d1d1d6;
            font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; }
  .tc-log .ev { color:#5ac8fa; } .tc-log .err { color:#ff453a; }
`;

export function buildUI(root: HTMLElement): HarnessUI {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  root.innerHTML = `
    <div class="tc-header">Transcoder <small>/ Test Harness / window.transcodeFile()</small></div>
    <div class="tc-body">
      <div class="tc-left">
        <div class="tc-drop" id="drop">Drop video<br><small>video · gif · image · or select multiple frames</small></div>
        <input type="file" id="file" multiple hidden />
        <div class="tc-files" id="files"></div>
        <button class="tc-start" id="start" disabled>Transcode</button>
        <div class="tc-bar"><div id="bar"></div></div>
        <div class="tc-status" id="status"></div>
      </div>
      <div class="tc-right">
        <div class="tc-out" id="out" style="display:none"></div>
        <pre class="tc-log" id="log"></pre>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  const drop = $('drop'), fileInput = $<HTMLInputElement>('file'), filesEl = $('files');
  const startBtn = $<HTMLButtonElement>('start');
  const bar = $('bar'), statusEl = $('status'), logEl = $('log'), outEl = $('out');

  let files: File[] = [];
  let startCb: ((files: File[]) => void) | null = null;

  const setFiles = (f: File[]) => {
    files = f;
    filesEl.textContent = f.length ? f.map((x) => x.name).join(', ') : '';
    startBtn.disabled = f.length === 0;
  };

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('drag');
    setFiles(Array.from(e.dataTransfer?.files ?? []));
  });
  fileInput.addEventListener('change', () => setFiles(Array.from(fileInput.files ?? [])));
  startBtn.addEventListener('click', () => {
    if (startCb && files.length) startCb(files);
  });

  return {
    onStart: (cb) => { startCb = cb; },
    setStatus: (msg, isError = false) => { statusEl.textContent = msg; statusEl.classList.toggle('err', isError); },
    setProgress: (percent) => { bar.style.width = `${Math.max(0, Math.min(100, percent))}%`; },
    appendLog: (line) => { logEl.appendChild(document.createTextNode(line + '\n')); logEl.scrollTop = logEl.scrollHeight; },
    clearLog: () => { logEl.textContent = ''; },
    showOutput: (url, kind, downloadName) => {
      outEl.style.display = 'block';
      const media = kind === 'video'
        ? `<video src="${url}" controls autoplay loop muted></video>`
        : `<img src="${url}" />`;
      outEl.innerHTML = `${media}<div style="margin-top:8px"><a href="${url}" download="${downloadName}">⬇ download ${downloadName}</a></div>`;
    },
    setFiles,
  };
}
