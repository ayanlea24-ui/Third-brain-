'use strict';

const path = require('path');
const fs = require('fs');
const { buildWorkspaceStoreApiJs } = require('./workspace-store');

const WORKSPACE_STORE_API_JS = buildWorkspaceStoreApiJs();
const RESUMES_STORAGE_KEY = 'secondBrainResumesV1';
const RESUME_UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads', 'resumes');

function ensureResumeUploadDir() {
  try {
    fs.mkdirSync(RESUME_UPLOAD_DIR, { recursive: true });
  } catch (err) {
    console.warn('[resumes] mkdir:', err && err.message ? err.message : err);
  }
}

function nextResumeId() {
  return 'rs' + Date.now() + Math.random().toString(36).slice(2, 9);
}

function resumeExtFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'application/pdf') return '.pdf';
  if (m === 'application/msword') return '.doc';
  if (
    m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return '.docx';
  return '';
}

function resumeExtFromOriginalName(name) {
  const n = String(name || '').toLowerCase();
  const m = n.match(/\.([a-z0-9]+)$/i);
  if (!m) return '';
  const ext = '.' + m[1].toLowerCase();
  if (['.pdf', '.doc', '.docx'].includes(ext)) return ext;
  return '';
}

function safeResumeStoredName(id, ext) {
  const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeExt = String(ext || '').replace(/[^a-zA-Z0-9.]/g, '');
  return safeId + safeExt;
}

function resumeFilePath(storedName) {
  if (!storedName || /[/\\]/.test(storedName)) return null;
  return path.join(RESUME_UPLOAD_DIR, storedName);
}

function normalizeResumeItem(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    id: String(item.id || '').trim(),
    label: String(item.label || '').trim(),
    jobTypes: String(item.jobTypes || '').trim(),
    originalName: String(item.originalName || '').trim(),
    storedName: String(item.storedName || '').trim(),
    mimeType: String(item.mimeType || '').trim(),
    size: Number(item.size) || 0,
    uploadedAt: String(item.uploadedAt || '').trim()
  };
}

function normalizeResumeStore(payload) {
  if (!payload || typeof payload !== 'object') return { version: 1, items: [] };
  const items = Array.isArray(payload.items) ? payload.items.map(normalizeResumeItem).filter(Boolean) : [];
  return { version: 1, items };
}

function findResumeInStore(store, id) {
  const items = store && Array.isArray(store.items) ? store.items : [];
  for (let i = 0; i < items.length; i++) {
    if (String(items[i].id) === String(id)) return items[i];
  }
  return null;
}

function buildResumesPageHtml() {
  const script =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var tbody=document.getElementById("rs-tbody");' +
    'var emptyEl=document.getElementById("rs-empty");' +
    'var form=document.getElementById("rs-upload-form");' +
    'var fLabel=document.getElementById("rs-label");' +
    'var fTypes=document.getElementById("rs-job-types");' +
    'var fFile=document.getElementById("rs-file");' +
    'var statusEl=document.getElementById("rs-status");' +
    'if(!tbody||!form)return;' +
    'function setStatus(msg,isErr){if(!statusEl)return;statusEl.textContent=msg||"";statusEl.classList.toggle("is-error",!!isErr);}' +
    'function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}' +
    'function formatSize(n){var b=Number(n)||0;if(b<1024)return b+" B";if(b<1048576)return Math.round(b/1024)+" KB";return (Math.round(b/1048576*10)/10)+" MB";}' +
    'function formatDate(iso){if(!iso)return"—";try{return new Date(iso).toLocaleString();}catch(e){return iso;}}' +
    'function loadList(){fetch("/api/resumes",{headers:{Accept:"application/json"}}).then(function(r){if(!r.ok)throw new Error("load failed");return r.json();}).then(function(data){renderList(data&&data.items?data.items:[]);}).catch(function(e){setStatus("Could not load resumes.",true);console.warn(e);});}' +
    'function renderList(items){tbody.innerHTML="";if(emptyEl)emptyEl.hidden=items.length>0;items.forEach(function(it){var tr=document.createElement("tr");tr.setAttribute("data-id",it.id);tr.innerHTML=' +
    '"<td><strong>"+esc(it.label||"Untitled")+"</strong><div class=\\"rs-meta\\">"+esc(it.originalName||"")+"</div></td>"+' +
    '"<td>"+esc(it.jobTypes||"—")+"</td>"+' +
    '"<td class=\\"rs-meta\\">"+formatSize(it.size)+"<br>"+formatDate(it.uploadedAt)+"</td>"+' +
    '"<td class=\\"rs-actions\\"><a class=\\"link-pill\\" href=\\"/api/resumes/"+encodeURIComponent(it.id)+"/download\\">Download</a> "+"<button type=\\"button\\" class=\\"rs-del\\" data-id=\\""+esc(it.id)+"\\">Delete</button></td>";' +
    'tbody.appendChild(tr);});}' +
    'form.addEventListener("submit",function(e){e.preventDefault();var label=fLabel?String(fLabel.value||"").trim():"";var types=fTypes?String(fTypes.value||"").trim():"";var file=fFile&&fFile.files&&fFile.files[0]?fFile.files[0]:null;if(!label){setStatus("Enter a resume name.",true);if(fLabel)fLabel.focus();return;}if(!file){setStatus("Choose a file to upload.",true);return;}setStatus("Uploading…");var fd=new FormData();fd.append("label",label);fd.append("jobTypes",types);fd.append("file",file);fetch("/api/resumes",{method:"POST",body:fd}).then(function(r){if(!r.ok)throw new Error("upload failed");return r.json();}).then(function(){if(fLabel)fLabel.value="";if(fTypes)fTypes.value="";if(fFile)fFile.value="";setStatus("Resume saved.");loadList();}).catch(function(err){setStatus("Upload failed. Try again.",true);console.warn(err);});});' +
    'tbody.addEventListener("click",function(e){var btn=e.target.closest(".rs-del");if(!btn)return;var id=btn.getAttribute("data-id");if(!id)return;if(!confirm("Delete this resume file? Jobs using it will lose the attachment."))return;fetch("/api/resumes/"+encodeURIComponent(id),{method:"DELETE"}).then(function(r){if(!r.ok)throw new Error("delete failed");loadList();setStatus("Resume deleted.");}).catch(function(){setStatus("Delete failed.",true);});});' +
    'loadList();' +
    '})();<' +
    '/script>';

  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Resume library</h1>' +
    '<p class="sub">Upload resumes, label them, and note what job types each one is for. Attach them on the job board.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/data-analytics/job-board">Job board</a>' +
    '<a class="link-pill" href="/">Home</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel rs-panel">' +
    '<style>' +
    '.rs-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.rs-upload{display:grid;gap:12px;margin:0 0 20px;padding:16px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;}' +
    '@media(min-width:720px){.rs-upload{grid-template-columns:1fr 1fr 1fr auto;align-items:end;}}' +
    '.rs-field label{display:block;font-size:12px;font-weight:700;color:#475569;margin:0 0 6px;}' +
    '.rs-field input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;font:inherit;font-size:14px;}' +
    '.rs-btn{padding:10px 18px;border:none;border-radius:10px;background:#0d9488;color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;}' +
    '.rs-btn:hover{background:#0f766e;}' +
    '.rs-status{margin:0 0 14px;font-size:13px;color:#64748b;}.rs-status.is-error{color:#b91c1c;}' +
    '.rs-table-wrap{overflow:auto;border:1px solid #e5e7eb;border-radius:10px;}' +
    '.rs-table{width:100%;border-collapse:collapse;min-width:640px;font-size:14px;}' +
    '.rs-table th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#334155;}' +
    '.rs-table td{padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top;}' +
    '.rs-meta{font-size:12px;color:#64748b;line-height:1.4;}' +
    '.rs-actions{white-space:nowrap;}' +
    '.rs-actions .link-pill{margin-right:8px;}' +
    '.rs-del{border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;}' +
    '.rs-del:hover{background:#fef2f2;}' +
    '.rs-empty{margin:0;padding:20px;text-align:center;color:#94a3b8;}' +
    '</style>' +
    '<form id="rs-upload-form" class="rs-upload">' +
    '<div class="rs-field"><label for="rs-label">Resume name</label><input type="text" id="rs-label" autocomplete="off" placeholder="e.g. Healthcare MRT v3" required /></div>' +
    '<div class="rs-field"><label for="rs-job-types">Job types</label><input type="text" id="rs-job-types" autocomplete="off" placeholder="e.g. Hospital, clinic, imaging" /></div>' +
    '<div class="rs-field"><label for="rs-file">File</label><input type="file" id="rs-file" accept=".pdf,.doc,.docx,application/pdf" required /></div>' +
    '<div class="rs-field"><label>&nbsp;</label><button type="submit" class="rs-btn">Upload</button></div>' +
    '</form>' +
    '<p id="rs-status" class="rs-status"></p>' +
    '<div class="rs-table-wrap">' +
    '<table class="rs-table" aria-label="Saved resumes">' +
    '<thead><tr><th>Resume</th><th>Job types</th><th>File</th><th></th></tr></thead>' +
    '<tbody id="rs-tbody"></tbody>' +
    '</table>' +
    '<p id="rs-empty" class="rs-empty" hidden>No resumes yet. Upload your first one above.</p>' +
    '</div>' +
    script +
    '</div></div>'
  );
}

module.exports = {
  RESUMES_STORAGE_KEY,
  RESUME_UPLOAD_DIR,
  ensureResumeUploadDir,
  nextResumeId,
  resumeExtFromMime,
  resumeExtFromOriginalName,
  safeResumeStoredName,
  resumeFilePath,
  normalizeResumeStore,
  normalizeResumeItem,
  findResumeInStore,
  buildResumesPageHtml
};
