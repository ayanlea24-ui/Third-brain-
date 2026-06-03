'use strict';

const { LEARNING_SEED_SECTIONS } = require('./learning-curriculum');
const { buildWorkspaceStoreApiJs } = require('./workspace-store');

const WORKSPACE_STORE_API_JS = buildWorkspaceStoreApiJs();

const LEARNING_STORAGE_KEY = 'secondBrainDataAnalyticsLearningV3';

function getTlLearningExtraStyles() {
  return (
    '<style>' +
    '.tl-learning .tl-col-time,.tl-learning .tl-table th:nth-child(1){display:none;}' +
    '.tl-learning .tl-add .tl-field-time{display:none;}' +
    '@media(min-width:720px){.tl-learning .tl-add{grid-template-columns:1fr 1fr 9.5rem auto;}}' +
    '@media(min-width:900px){.tl-learning .tl-top-split .tl-add{grid-template-columns:1fr;}}' +
    '.tl-row-section td{background:#f1f5f9;font-size:12px;font-weight:800;color:#334155;letter-spacing:0.03em;padding:11px 12px;border-bottom:1px solid #e2e8f0;}' +
    '.tl-learning .tl-table th:nth-child(3){width:11rem;}' +
    '.tl-learning .tl-table th:nth-child(4){width:9.5rem;}' +
    '.tl-learning .tl-table th:nth-child(5){width:8.75rem;text-align:right;}' +
    '.tl-progress-cell{min-width:10rem;}' +
    '.tl-progress-wrap{display:flex;align-items:center;min-width:9rem;}' +
    '.tl-progress-controls{display:flex;align-items:center;gap:8px;width:100%;}' +
    '.tl-task-progress{flex:1;min-width:5rem;height:8px;margin:0;accent-color:#0d9488;cursor:pointer;}' +
    '.tl-progress-pct{font-size:12px;font-weight:700;color:#475569;min-width:2.75rem;text-align:right;font-variant-numeric:tabular-nums;}' +
    'a.tl-icon-btn{text-decoration:none;box-sizing:border-box;}' +
    '.tl-icon-btn.tl-long-notes-btn:hover{background:#f5f3ff;border-color:#ddd6fe;color:#6d28d9;}' +
    '.tl-icon-btn.tl-long-notes-btn.has-content{position:relative;}' +
    '.tl-icon-btn.tl-long-notes-btn.has-content::after{content:"";position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:#7c3aed;border:1.5px solid #fff;}' +
    '.tl-row-module .tl-view-text{font-weight:700;color:#0f172a;}' +
    '.tl-row-subtask .tl-view-text{padding-left:14px;color:#334155;}' +
    '.tl-row-subtask .tl-view-text::before{content:"↳ ";color:#94a3b8;font-weight:600;}' +
    '.tl-row-module td,.tl-row-subtask td{border-bottom-color:#f1f5f9;}' +
    '</style>'
  );
}

function buildLearningClientScript(storageKey, statuses) {
  return (
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var _learnCache=null;' +
    'var SK=' +
    JSON.stringify(storageKey) +
    ';' +
    'var SEED=' +
    JSON.stringify(LEARNING_SEED_SECTIONS) +
    ';' +
    'var STATUSES=' +
    JSON.stringify(statuses) +
    ';' +
    'var STATUS_MAP={};STATUSES.forEach(function(p){STATUS_MAP[p[0]]=p[1];});' +
    'var SVG_PENCIL=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>\';' +
    'var SVG_TRASH=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>\';' +
    'var SVG_LONG_NOTE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M8 7h8"/><path d="M8 11h6"/></svg>\';' +
    'var SVG_NOTE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>\';' +
    'var SVG_CHECK=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>\';' +
    'var SVG_MARK_DONE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9" stroke-linecap="round" stroke-linejoin="round"/></svg>\';' +
    'var SVG_X=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>\';' +
    'function makeIconBtn(cls,label,svg){var b=document.createElement("button");b.type="button";b.className="tl-icon-btn "+cls;b.setAttribute("aria-label",label);b.innerHTML=svg;return b;}' +
    'var statusFilter="all";' +
    'var editingId=null;' +
    'var tbody=document.getElementById("tl-tbody");' +
    'var emptyEl=document.getElementById("tl-empty");' +
    'var progressEl=document.getElementById("tl-day-label");' +
    'var addText=document.getElementById("tl-add-text");' +
    'var addSection=document.getElementById("tl-add-section");' +
    'var addStatus=document.getElementById("tl-add-status");' +
    'var addBtn=document.getElementById("tl-add-btn");' +
    'var overviewCol=document.getElementById("tl-overview-col");' +
    'var overviewHost=document.getElementById("tl-overview-host");' +
    'var overviewNow=document.getElementById("tl-overview-now");' +
    'var overviewCollapseBtn=document.getElementById("tl-overview-collapse");' +
    'var overviewExpandBtn=document.getElementById("tl-overview-expand");' +
    'var notesPanel=document.getElementById("tl-notes-panel");' +
    'var notesField=document.getElementById("tl-day-notes");' +
    'var notesSaveTimer=null;' +
    'var taskNotesSaveTimers={};var progressSaveTimers={};' +
    'if(!tbody)return;' +
    'function nextId(){return"x"+Date.now()+Math.random().toString(36).slice(2,9);}' +
    'function normStatus(s){var v=String(s||"").trim();for(var i=0;i<STATUSES.length;i++){if(STATUSES[i][0]===v)return v;}return"not_started";}' +
    'function normProgress(n){var v=parseInt(n,10);if(isNaN(v))return 0;if(v<0)return 0;if(v>100)return 100;return v;}' +
    'function normTask(t){if(!t||typeof t!=="object")return t;if(typeof t.notes!=="string")t.notes="";if(typeof t.longNotes!=="string")t.longNotes="";if(t.parentId!=null&&String(t.parentId).trim()==="")t.parentId=null;else if(t.parentId!=null)t.parentId=String(t.parentId);if(typeof t.isModule!=="boolean")t.isModule=!!t.isModule;if(typeof t.notesOpen!=="boolean")t.notesOpen=false;if(typeof t.time!=="string")t.time="";if(typeof t.progress!=="number"||isNaN(t.progress))t.progress=normStatus(t.status)==="done"?100:0;else t.progress=normProgress(t.progress);return t;}' +
    'function buildSeedStore(){var sections=[];SEED.forEach(function(sec,si){var sid="sec-"+(si+1);var tasks=[];var n=0;(sec.topics||[]).forEach(function(item){if(typeof item==="string"){n++;tasks.push({id:sid+"-"+n,text:item,time:"",status:"not_started",notes:"",notesOpen:false,progress:0,longNotes:"",parentId:null,isModule:false});}else if(item&&typeof item==="object"){n++;var pid=sid+"-"+n;tasks.push({id:pid,text:String(item.topic||item.title||"Topic"),time:"",status:"not_started",notes:"",notesOpen:false,progress:0,longNotes:"",parentId:null,isModule:true});(item.subtasks||[]).forEach(function(st){n++;tasks.push({id:sid+"-"+n,text:String(st||"").trim(),time:"",status:"not_started",notes:"",notesOpen:false,progress:0,longNotes:"",parentId:pid,isModule:false});});}});sections.push({id:sid,title:sec.title,tasks:tasks});});return{version:3,sections:sections,activeSectionId:sections[0]?sections[0].id:"",notes:"",notesOpen:false,overviewCollapsed:false};}' +
    'function normStore(o){if(!o||typeof o!=="object"||!Array.isArray(o.sections)||o.version!==3)return buildSeedStore();o.sections.forEach(function(sec){if(!Array.isArray(sec.tasks))sec.tasks=[];sec.tasks=sec.tasks.map(normTask);});if(typeof o.notes!=="string")o.notes="";if(typeof o.notesOpen!=="boolean")o.notesOpen=false;if(typeof o.overviewCollapsed!=="boolean")o.overviewCollapsed=false;if(typeof o.activeSectionId!=="string")o.activeSectionId=o.sections[0]?o.sections[0].id:"";return o;}' +
    'function readStore(){if(_learnCache)return _learnCache;return buildSeedStore();}' +
    'function writeStore(o){_learnCache=normStore(o);wsPut(SK,_learnCache);}' +
    'function loadOverviewUi(){var o=readStore();var collapsed=!!o.overviewCollapsed;if(overviewCol)overviewCol.classList.toggle("is-collapsed",collapsed);if(overviewCollapseBtn){overviewCollapseBtn.disabled=collapsed;overviewCollapseBtn.setAttribute("aria-expanded",collapsed?"false":"true");}if(overviewExpandBtn){overviewExpandBtn.disabled=!collapsed;overviewExpandBtn.setAttribute("aria-expanded",collapsed?"true":"false");}}' +
    'function setOverviewCollapsed(collapsed){var o=readStore();o.overviewCollapsed=!!collapsed;writeStore(o);loadOverviewUi();}' +
    'function loadDayNotesUi(){var o=readStore();if(notesField&&notesField.value!==o.notes)notesField.value=o.notes;if(notesPanel)notesPanel.open=!!o.notesOpen;}' +
    'function saveDayNotes(val){var o=readStore();o.notes=String(val!=null?val:"");writeStore(o);}' +
    'function saveDayNotesOpen(open){var o=readStore();o.notesOpen=!!open;writeStore(o);}' +
    'function scheduleDayNotesSave(){if(notesSaveTimer)clearTimeout(notesSaveTimer);notesSaveTimer=setTimeout(function(){notesSaveTimer=null;if(notesField)saveDayNotes(notesField.value);},400);}' +
    'function scheduleTaskNotesSave(id,val){if(taskNotesSaveTimers[id])clearTimeout(taskNotesSaveTimers[id]);taskNotesSaveTimers[id]=setTimeout(function(){delete taskNotesSaveTimers[id];updateTask(id,{notes:String(val!=null?val:"")},false);},400);}function scheduleProgressSave(id,val){if(progressSaveTimers[id])clearTimeout(progressSaveTimers[id]);progressSaveTimers[id]=setTimeout(function(){delete progressSaveTimers[id];var v=normProgress(val);var patch={progress:v};if(v>=100)patch.status="done";else if(v>0){var o=readStore();var loc=findTaskLoc(o,id);if(loc&&normStatus(loc.task.status)==="not_started")patch.status="in_progress";}updateTask(id,patch,false);renderOverview();},180);}function appendProgressCell(task){var td=document.createElement("td");td.className="tl-progress-cell";var pct=normProgress(task.progress);var wrap=document.createElement("div");wrap.className="tl-progress-wrap";var row=document.createElement("div");row.className="tl-progress-controls";var slider=document.createElement("input");slider.type="range";slider.min="0";slider.max="100";slider.step="5";slider.className="tl-task-progress";slider.value=String(pct);slider.setAttribute("data-id",task.id);slider.setAttribute("aria-valuenow",String(pct));slider.setAttribute("aria-valuemin","0");slider.setAttribute("aria-valuemax","100");var lab=document.createElement("span");lab.className="tl-progress-pct";lab.textContent=pct+"%";slider.addEventListener("input",function(){var v=normProgress(slider.value);lab.textContent=v+"%";slider.setAttribute("aria-valuenow",String(v));});row.appendChild(slider);row.appendChild(lab);wrap.appendChild(row);td.appendChild(wrap);return td;}function findTaskLoc(o,id){for(var i=0;i<o.sections.length;i++){for(var j=0;j<o.sections[i].tasks.length;j++){if(String(o.sections[i].tasks[j].id)===String(id))return{section:o.sections[i],task:o.sections[i].tasks[j],si:i,ti:j};}}return null;}' +
    'function flatRoute(o){var out=[];o.sections.forEach(function(sec,si){sec.tasks.forEach(function(task,ti){out.push({id:task.id,text:task.text,status:task.status,time:task.time,notes:task.notes,notesOpen:task.notesOpen,progress:normProgress(task.progress),parentId:task.parentId||null,isModule:!!task.isModule,sectionId:sec.id,sectionTitle:sec.title,label:(si+1)+"."+(ti+1)});});});return out;}' +
    'function statusBadge(st){var s=normStatus(st);var lab=STATUS_MAP[s]||s;return"<span class=\\"tl-badge tl-badge-"+s+"\\">"+lab+"</span>";}' +
    'function statusOptions(sel){var h="";STATUSES.forEach(function(p){h+="<option value=\\""+p[0]+"\\""+(sel===p[0]?" selected":"")+">"+p[1]+"</option>";});return h;}' +
    'function matchesStatus(task){if(statusFilter==="all")return true;return normStatus(task.status)===statusFilter;}function visibleTasksForSection(sec){var show={};sec.tasks.forEach(function(t){if(matchesStatus(t))show[t.id]=true;});sec.tasks.forEach(function(t){if(t.parentId&&show[t.id])show[t.parentId]=true;});sec.tasks.forEach(function(t){if(t.isModule&&show[t.id]){sec.tasks.forEach(function(c){if(String(c.parentId)===String(t.id))show[c.id]=true;});}});return sec.tasks.filter(function(t){return show[t.id];});}' +
    'function countProgress(o){var done=0,total=0,sum=0;o.sections.forEach(function(sec){sec.tasks.forEach(function(t){total++;var pr=normProgress(t.progress);sum+=pr;if(normStatus(t.status)==="done")done++;});});return{done:done,total:total,pct:total?Math.round(sum/total):0};}' +
    'function pickCurrentTaskId(route){var i;for(i=0;i<route.length;i++){if(normStatus(route[i].status)==="in_progress")return route[i].id;}for(i=0;i<route.length;i++){var st=normStatus(route[i].status);if(st!=="done"&&st!=="skipped")return route[i].id;}return null;}' +
    'function renderOverview(){if(!overviewHost)return;var o=readStore();var route=flatRoute(o);var currentId=pickCurrentTaskId(route);if(overviewNow){var cur=currentId?route.filter(function(t){return t.id===currentId;})[0]:null;overviewNow.classList.toggle("is-in-progress-active",!!(cur&&normStatus(cur.status)==="in_progress"));overviewNow.innerHTML=cur?"Now: <strong>"+String(cur.text||"Topic").replace(/</g,"&lt;")+"</strong> · "+String(cur.sectionTitle||"").replace(/</g,"&lt;"):"Pick a topic and set status to In progress to track your path.";}overviewHost.innerHTML="";if(!route.length){overviewHost.innerHTML=\'<p class="tl-overview-empty">Add topics to build your learning path.</p>\';return;}var wrap=document.createElement("div");wrap.className="tl-route";wrap.setAttribute("role","list");route.forEach(function(task,idx){var st=normStatus(task.status);var stop=document.createElement("div");stop.className="tl-stop";if(task.id===currentId)stop.classList.add("is-current");if(st==="in_progress")stop.classList.add("is-in-progress");if(st==="done")stop.classList.add("is-done");if(st==="skipped")stop.classList.add("is-skipped");stop.setAttribute("role","listitem");stop.setAttribute("data-id",task.id);var timeEl=document.createElement("div");timeEl.className="tl-stop-time";timeEl.textContent=task.label;var track=document.createElement("div");track.className="tl-stop-track";var dot=document.createElement("span");dot.className="tl-stop-dot";dot.setAttribute("aria-hidden","true");var line=document.createElement("span");line.className="tl-stop-line";line.setAttribute("aria-hidden","true");track.appendChild(dot);track.appendChild(line);var body=document.createElement("div");body.className="tl-stop-body";var title=document.createElement("p");title.className="tl-stop-title";title.textContent=String(task.text||"Topic");var meta=document.createElement("p");meta.className="tl-stop-meta";var metaBits=[STATUS_MAP[st]||st,task.sectionTitle];if(normProgress(task.progress)>0)metaBits.push(normProgress(task.progress)+"%");if(task.id===currentId)metaBits.push("You are here");meta.textContent=metaBits.join(" · ");body.appendChild(title);body.appendChild(meta);stop.appendChild(timeEl);stop.appendChild(track);stop.appendChild(body);wrap.appendChild(stop);});overviewHost.appendChild(wrap);}' +
    'function appendTaskRow(task,isEdit){var tr=document.createElement("tr");tr.setAttribute("data-id",task.id);if(normStatus(task.status)==="done")tr.className="tl-row-done";if(task.isModule)tr.classList.add("tl-row-module");if(task.parentId)tr.classList.add("tl-row-subtask");var tdTime=document.createElement("td");tdTime.className="tl-col-time";var tdText=document.createElement("td");var tdProgress=appendProgressCell(task);var tdStatus=document.createElement("td");if(isEdit){var inpText=document.createElement("input");inpText.type="text";inpText.className="tl-task-text";inpText.value=String(task.text||"");inpText.placeholder="Topic";tdText.appendChild(inpText);var selStatus=document.createElement("select");selStatus.className="tl-task-status";selStatus.innerHTML=statusOptions(normStatus(task.status));tdStatus.appendChild(selStatus);}else{var viewText=document.createElement("span");viewText.className="tl-view-text";var txt=String(task.text||"").trim();viewText.textContent=txt||"Untitled topic";if(!txt)viewText.classList.add("tl-view-empty");tdText.appendChild(viewText);tdStatus.innerHTML=statusBadge(task.status);}var tdAct=document.createElement("td");tdAct.className="tl-td-actions";var actWrap=document.createElement("div");actWrap.className="tl-actions";if(isEdit){actWrap.appendChild(makeIconBtn("tl-save","Save topic",SVG_CHECK));actWrap.appendChild(makeIconBtn("tl-cancel","Cancel editing",SVG_X));}else{var btnNotes=makeIconBtn("tl-notes-btn","Notes",SVG_NOTE);btnNotes.setAttribute("data-id",task.id);if(task.notesOpen)btnNotes.classList.add("is-open");if(String(task.notes||"").trim())btnNotes.classList.add("has-content");actWrap.appendChild(btnNotes);var btnLong=document.createElement("a");btnLong.href="/data-analytics/learning/topic/"+encodeURIComponent(task.id);btnLong.className="tl-icon-btn tl-long-notes-btn";btnLong.setAttribute("aria-label","Open long notes");btnLong.innerHTML=SVG_LONG_NOTE;if(String(task.longNotes||"").trim())btnLong.classList.add("has-content");actWrap.appendChild(btnLong);actWrap.appendChild(makeIconBtn("tl-edit","Edit topic",SVG_PENCIL));var btnDone=makeIconBtn("tl-done","Mark as done",SVG_MARK_DONE);if(normStatus(task.status)==="done"){btnDone.disabled=true;btnDone.classList.add("is-active");}actWrap.appendChild(btnDone);actWrap.appendChild(makeIconBtn("tl-remove","Remove topic",SVG_TRASH));}tdAct.appendChild(actWrap);tr.appendChild(tdTime);tr.appendChild(tdText);tr.appendChild(tdProgress);tr.appendChild(tdStatus);tr.appendChild(tdAct);tbody.appendChild(tr);var trN=document.createElement("tr");trN.className="tl-row-notes";trN.setAttribute("data-for",task.id);if(!task.notesOpen)trN.hidden=true;var tdN=document.createElement("td");tdN.colSpan=5;var panel=document.createElement("div");panel.className="tl-task-notes-panel";var ta=document.createElement("textarea");ta.className="tl-notes-field tl-task-notes";ta.setAttribute("data-id",task.id);ta.value=String(task.notes||"");ta.placeholder="Notes for this topic…";ta.spellcheck=true;panel.appendChild(ta);tdN.appendChild(panel);trN.appendChild(tdN);tbody.appendChild(trN);if(isEdit){var focusText=tr.querySelector(".tl-task-text");if(focusText)focusText.focus();}}' +
    'function renderTable(){var o=readStore();if(editingId&&!findTaskLoc(o,editingId))editingId=null;tbody.innerHTML="";var shown=0;o.sections.forEach(function(sec){var secTasks=visibleTasksForSection(sec);if(!secTasks.length)return;var trH=document.createElement("tr");trH.className="tl-row-section";var tdH=document.createElement("td");tdH.colSpan=5;tdH.textContent=sec.title;trH.appendChild(tdH);tbody.appendChild(trH);secTasks.forEach(function(task){shown++;appendTaskRow(task,editingId===task.id);});});if(emptyEl)emptyEl.hidden=shown>0;}' +
    'function render(){var o=readStore();var p=countProgress(o);if(progressEl)progressEl.textContent=p.done+" / "+p.total+" topics · "+p.pct+"% overall progress";if(addSection&&addSection.value!==o.activeSectionId)addSection.value=o.activeSectionId;loadDayNotesUi();loadOverviewUi();renderTable();renderOverview();}' +
    'function updateTask(id,patch,rerender){var o=readStore();var loc=findTaskLoc(o,id);if(loc)Object.assign(loc.task,patch);writeStore(o);if(rerender!==false)render();else renderOverview();}' +
    'function removeTask(id){var o=readStore();var loc=findTaskLoc(o,id);if(loc)loc.section.tasks=loc.section.tasks.filter(function(t){return String(t.id)!==String(id);});writeStore(o);render();}' +
    'function addTask(){var text=addText?String(addText.value||"").trim():"";if(!text)return;var o=readStore();var sid=addSection?String(addSection.value||""):"";var sec=null;for(var i=0;i<o.sections.length;i++){if(o.sections[i].id===sid){sec=o.sections[i];break;}}if(!sec&&o.sections.length)sec=o.sections[0];if(!sec)return;sec.tasks.push({id:nextId(),text:text,time:"",status:addStatus?normStatus(addStatus.value):"not_started",notes:"",notesOpen:false,progress:0,longNotes:"",parentId:null,isModule:false});o.activeSectionId=sec.id;writeStore(o);if(addText)addText.value="";if(addStatus)addStatus.value="not_started";render();if(addText)addText.focus();}' +
    'document.querySelectorAll(".tl-filter[data-kind=status]").forEach(function(btn){btn.addEventListener("click",function(){statusFilter=btn.getAttribute("data-filter")||"all";document.querySelectorAll(".tl-filter[data-kind=status]").forEach(function(b){b.classList.toggle("is-active",b===btn);});render();});});' +
    'if(addBtn)addBtn.addEventListener("click",addTask);' +
    'if(addText)addText.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();addTask();}});' +
    'if(addSection)addSection.addEventListener("change",function(){var o=readStore();o.activeSectionId=String(addSection.value||"");writeStore(o);});' +
    'tbody.addEventListener("input",function(e){if(e.target.classList.contains("tl-task-progress")){var pid=e.target.getAttribute("data-id");if(pid)scheduleProgressSave(pid,e.target.value);return;}if(!e.target.classList.contains("tl-task-notes"))return;var id=e.target.getAttribute("data-id");if(id)scheduleTaskNotesSave(id,e.target.value);});' +
    'tbody.addEventListener("blur",function(e){if(!e.target.classList.contains("tl-task-notes"))return;var id=e.target.getAttribute("data-id");if(!id)return;if(taskNotesSaveTimers[id]){clearTimeout(taskNotesSaveTimers[id]);delete taskNotesSaveTimers[id];}updateTask(id,{notes:String(e.target.value||"")},false);},true);' +
    'if(notesField){notesField.addEventListener("input",scheduleDayNotesSave);notesField.addEventListener("blur",function(){if(notesSaveTimer){clearTimeout(notesSaveTimer);notesSaveTimer=null;}saveDayNotes(notesField.value);});}' +
    'if(notesPanel){notesPanel.addEventListener("toggle",function(){saveDayNotesOpen(notesPanel.open);});}' +
    'function saveEditingRow(tr){if(!tr)return;var id=tr.getAttribute("data-id");var inpText=tr.querySelector(".tl-task-text");var selStatus=tr.querySelector(".tl-task-status");var notesTa=tr.parentNode?tr.parentNode.querySelector(\'textarea.tl-task-notes[data-id="\'+id+\'"]\'):null;var text=inpText?String(inpText.value||"").trim():"";if(!text){if(inpText)inpText.focus();return;}var inpProg=tr.querySelector(".tl-task-progress");var patch={text:text,status:selStatus?normStatus(selStatus.value):"not_started"};if(inpProg)patch.progress=normProgress(inpProg.value);if(normStatus(patch.status)==="done")patch.progress=100;if(notesTa)patch.notes=String(notesTa.value||"");editingId=null;updateTask(id,patch,true);}' +
    'tbody.addEventListener("keydown",function(e){var tr=e.target.closest("tr[data-id]");if(!tr||editingId!==tr.getAttribute("data-id"))return;if(e.key==="Enter"&&e.target.classList.contains("tl-task-text")){e.preventDefault();saveEditingRow(tr);}else if(e.key==="Escape"){e.preventDefault();editingId=null;render();}});' +
    'tbody.addEventListener("click",function(e){var notesBtn=e.target.closest(".tl-notes-btn");if(notesBtn){var nid=notesBtn.getAttribute("data-id");if(nid){var o=readStore();var loc=findTaskLoc(o,nid);if(loc)updateTask(nid,{notesOpen:!loc.task.notesOpen},true);}return;}var tr=e.target.closest("tr[data-id]");if(!tr)return;var id=tr.getAttribute("data-id");if(e.target.closest(".tl-edit")){editingId=id;render();return;}if(e.target.closest(".tl-done")){updateTask(id,{status:"done",progress:100},true);return;}if(e.target.closest(".tl-save")){saveEditingRow(tr);return;}if(e.target.closest(".tl-cancel")){editingId=null;render();return;}if(e.target.closest(".tl-remove")){if(editingId===id)editingId=null;removeTask(id);}});' +
    'document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"){wsGet(SK,function(err,d){_learnCache=normStore(d||buildSeedStore());render();});}});' +
    'if(overviewCollapseBtn)overviewCollapseBtn.addEventListener("click",function(){setOverviewCollapsed(true);});' +
    'if(overviewExpandBtn)overviewExpandBtn.addEventListener("click",function(){setOverviewCollapsed(false);});' +
    'if(overviewHost)overviewHost.addEventListener("click",function(e){var stop=e.target.closest(".tl-stop");if(!stop)return;var id=stop.getAttribute("data-id");var tr=tbody.querySelector(\'tr[data-id="\'+id+\'"]\');if(tr){tr.scrollIntoView({behavior:"smooth",block:"nearest"});tr.classList.add("tl-row-focus");setTimeout(function(){tr.classList.remove("tl-row-focus");},1200);}});' +
    'wsGet(SK,function(err,d){_learnCache=normStore(d||buildSeedStore());if(!d)writeStore(_learnCache);render();});' +
    '})();<' +
    '/script>'
  );
}

function buildLearningWorkspaceHtml(deps) {
  const { getTlListStyles, escAttr, escHtml, statuses, dataAnalyticsSubNavHtml } = deps;
  const subNav = dataAnalyticsSubNavHtml
    ? dataAnalyticsSubNavHtml('/data-analytics/learning')
    : '';
  const statusOpts = statuses
    .map(([v, lab]) => '<option value="' + escAttr(v) + '">' + escHtml(lab) + '</option>')
    .join('');
  const sectionOpts = LEARNING_SEED_SECTIONS.map((sec, si) => {
    const id = 'sec-' + (si + 1);
    const short = sec.title.replace(/^Section \d+:\s*/, '');
    return '<option value="' + escAttr(id) + '">' + escHtml(short) + '</option>';
  }).join('');
  const statusFilterBtns =
    '<button type="button" class="tl-filter is-active" data-kind="status" data-filter="all">All</button>' +
    statuses
      .map(
        ([v, lab]) =>
          '<button type="button" class="tl-filter" data-kind="status" data-filter="' +
          escAttr(v) +
          '">' +
          escHtml(lab) +
          '</button>'
      )
      .join('');
  const tlScript = buildLearningClientScript(LEARNING_STORAGE_KEY, statuses);

  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Data analytics</h1>' +
    '<p class="sub">Learning track — work through topics section by section. Saved in MongoDB.</p>' +
    subNav +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/data-analytics/new">Add note</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tl-panel tl-learning">' +
    getTlListStyles() +
    getTlLearningExtraStyles() +
    '<div class="tl-dayhead">' +
    '<div><h2 id="tl-day-label">Loading…</h2><p>Progress is saved locally. Add your own topics to any section.</p></div>' +
    '</div>' +
    '<p class="tl-hint">Work through each section at your own pace. Use Notes on a topic for detail, Done when finished, and the overview to see where you are.</p>' +
    '<div class="tl-top-split">' +
    '<div class="tl-add">' +
    '<div class="tl-field"><label for="tl-add-section">Section</label><select id="tl-add-section">' +
    sectionOpts +
    '</select></div>' +
    '<div class="tl-field"><label for="tl-add-text">Topic</label><input type="text" id="tl-add-text" autocomplete="off" placeholder="New topic title" /></div>' +
    '<div class="tl-field tl-field-time"><label for="tl-add-status">Status</label><select id="tl-add-status">' +
    statusOpts +
    '</select></div>' +
    '<div class="tl-field"><label>&nbsp;</label><button type="button" id="tl-add-btn" class="tl-btn-add">+ Add</button></div>' +
    '</div>' +
    '<aside class="tl-overview-col" id="tl-overview-col" aria-label="Learning overview">' +
    '<div class="tl-overview-head">' +
    '<h3>Learning overview</h3>' +
    '<div class="tl-overview-toggles">' +
    '<button type="button" id="tl-overview-collapse" class="tl-overview-toggle" aria-label="Collapse overview" aria-controls="tl-overview-body" aria-expanded="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg></button>' +
    '<button type="button" id="tl-overview-expand" class="tl-overview-toggle" aria-label="Expand overview" aria-controls="tl-overview-body" aria-expanded="false" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>' +
    '</div></div>' +
    '<div id="tl-overview-body" class="tl-overview-body">' +
    '<p id="tl-overview-now" class="tl-overview-now">Your current topic will show here.</p>' +
    '<div id="tl-overview-host"></div>' +
    '</div></aside>' +
    '</div>' +
    '<div class="tl-filters" role="group" aria-label="Filter by status">' +
    statusFilterBtns +
    '</div>' +
    '<div class="tl-table-wrap">' +
    '<table class="tl-table" aria-label="Learning topics">' +
    '<thead><tr><th class="tl-col-time">#</th><th>Topic</th><th>Progress</th><th>Status</th><th></th></tr></thead>' +
    '<tbody id="tl-tbody"></tbody>' +
    '</table>' +
    '<p id="tl-empty" class="tl-empty" hidden>No topics for this filter yet.</p>' +
    '</div>' +
    '<div class="tl-day-notes-section">' +
    '<details class="tl-day-notes" id="tl-notes-panel">' +
    '<summary>Notes for your learning track</summary>' +
    '<div class="tl-notes-body">' +
    '<textarea id="tl-day-notes" class="tl-notes-field" spellcheck="true" autocomplete="off" placeholder="General notes, links, or goals for this curriculum…"></textarea>' +
    '<p class="tl-notes-hint">Saved with your learning list. Collapse when you do not need it.</p>' +
    '</div>' +
    '</details>' +
    '</div>' +
    tlScript +
    '</div></div>'
  );
}

const OVERVIEW_STORAGE_KEY = 'secondBrainDataAnalyticsOverviewV2';
const MEDICAL_PHYSICS_OVERVIEW_STORAGE_KEY = 'secondBrainStudyingMedicalPhysicsOverviewV1';

const CAREER_STAGES = [
  { id: 'learning', label: 'Learning', hint: 'Courses, study, and skill building' },
  { id: 'certification', label: 'Certifications', hint: 'Exams, credentials, and certificates' },
  { id: 'application', label: 'Practical application', hint: 'Projects, portfolios, and hands-on work' },
  { id: 'job', label: 'Job notices & applications', hint: 'Roles you are targeting or applying to' }
];

function getTlCareerExtraStyles() {
  return (
    '<style>' +
    '.tl-career .da-overview-main{display:flex;justify-content:center;margin:0 0 20px;}' +
    '.tl-career .da-overview-main .tl-overview-col{width:100%;max-width:580px;margin:0;}' +
    '.tl-career .da-overview-main .tl-overview-body{max-height:min(44vh,440px);overflow-y:auto;-webkit-overflow-scrolling:touch;padding-right:4px;}' +
    '.tl-career .tl-add{margin:0 0 16px;}' +
    '@media(min-width:720px){.tl-career .tl-add{grid-template-columns:minmax(8rem,1fr) 1.35fr 1fr 9rem minmax(8rem,1fr) auto;}}' +
    '.tl-career .tl-table-wrap{margin-top:0;}' +
    '.da-manage-wrap{margin:0 0 4px;}' +
    '.da-manage-bar{display:flex;justify-content:center;margin:0 0 10px;}' +
    '.da-manage-toggle{padding:9px 16px;border:1px solid #e2e8f0;border-radius:999px;background:#fff;font:inherit;font-size:13px;font-weight:700;color:#475569;cursor:pointer;transition:background .15s,border-color .15s,color .15s;}' +
    '.da-manage-toggle:hover{background:#f0fdfa;border-color:#99f6e4;color:#0f766e;}' +
    '.da-manage-wrap.is-collapsed .da-manage-body{display:none;}' +
    '.tl-stop.is-phase .tl-stop-title{font-size:14px;font-weight:800;}' +
    '.tl-stop.is-phase .tl-stop-meta{font-size:11px;}' +
    '.tl-stop.is-entry{cursor:pointer;}' +
    '.da-overview-empty-route{margin:0;padding:20px 8px;text-align:center;font-size:13px;color:#94a3b8;line-height:1.5;}' +
    '.tl-career .tl-view-detail{display:block;font-size:12px;color:#64748b;margin-top:4px;}' +
    '.tl-career .tl-task-detail{margin-top:6px;}' +
    '.tl-career .tl-task-detail,.tl-career .tl-task-text{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:13px;}' +
    '</style>'
  );
}

function buildOverviewClientScript(statuses, options) {
  options = options || {};
  const storageKey = options.storageKey || OVERVIEW_STORAGE_KEY;
  const stages = options.stages || CAREER_STAGES;
  return (
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var _ovCache=null;' +
    'var STATUSES=' +
    JSON.stringify(statuses || []) +
    ';' +
    'var STATUS_MAP={};STATUSES.forEach(function(p){STATUS_MAP[p[0]]=p[1];});' +
    'var OV_SK=' +
    JSON.stringify(storageKey) +
    ';' +
    'var STAGES=' +
    JSON.stringify(stages) +
    ';' +
    'var SVG_PENCIL=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>\';' +
    'var SVG_TRASH=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>\';' +
    'var SVG_MARK_DONE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9" stroke-linecap="round" stroke-linejoin="round"/></svg>\';' +
    'var SVG_CHECK=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>\';' +
    'var SVG_X=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>\';' +
    'function makeIconBtn(cls,label,svg){var b=document.createElement("button");b.type="button";b.className="tl-icon-btn "+cls;b.setAttribute("aria-label",label);b.innerHTML=svg;return b;}' +
    'var editingId=null;' +
    'var host=document.getElementById("da-career-host");' +
    'var tbody=document.getElementById("da-tbody");' +
    'var emptyEl=document.getElementById("da-empty");' +
    'var labelEl=document.getElementById("da-overview-label");' +
    'var nowEl=document.getElementById("da-overview-now");' +
    'var overviewCol=document.getElementById("da-overview-col");' +
    'var collapseBtn=document.getElementById("da-overview-collapse");' +
    'var expandBtn=document.getElementById("da-overview-expand");' +
    'var inpStage=document.getElementById("da-ov-stage");' +
    'var inpTitle=document.getElementById("da-ov-title");' +
    'var inpDetail=document.getElementById("da-ov-detail");' +
    'var inpDate=document.getElementById("da-ov-date");' +
    'var inpStatus=document.getElementById("da-ov-status");' +
    'var addBtn=document.getElementById("da-ov-add-btn");' +
    'var manageWrap=document.getElementById("da-manage-wrap");' +
    'var manageToggle=document.getElementById("da-manage-toggle");' +
    'if(!host||!tbody)return;' +
    'function nextId(){return"ov"+Date.now()+Math.random().toString(36).slice(2,9);}' +
    'function normStatus(s){var v=String(s||"").trim();for(var i=0;i<STATUSES.length;i++){if(STATUSES[i][0]===v)return v;}return"not_started";}' +
    'function defaultOverview(){return{version:2,items:[],overviewCollapsed:false,manageCollapsed:false};}' +
    'function normOverview(o){if(!o||typeof o!=="object")return defaultOverview();if(!Array.isArray(o.items))o.items=[];if(typeof o.overviewCollapsed!=="boolean")o.overviewCollapsed=false;if(typeof o.manageCollapsed!=="boolean")o.manageCollapsed=false;return o;}' +
    'function readOverview(){if(_ovCache)return _ovCache;return defaultOverview();}' +
    'function writeOverview(o){_ovCache=normOverview(o);wsPut(OV_SK,_ovCache);}' +
    'var STAGE_ORDER={};STAGES.forEach(function(s,i){STAGE_ORDER[s.id]=i;});' +
    'function stageLabel(id){for(var i=0;i<STAGES.length;i++){if(STAGES[i].id===id)return STAGES[i].label;}return id;}' +
    'function sortedItems(items){return items.slice().sort(function(a,b){var sa=STAGE_ORDER[a.stage]!=null?STAGE_ORDER[a.stage]:99;var sb=STAGE_ORDER[b.stage]!=null?STAGE_ORDER[b.stage]:99;if(sa!==sb)return sa-sb;return String(a.date||"").localeCompare(String(b.date||""));});}' +
    'function pickCurrentId(items){var list=sortedItems(items);var i;for(i=0;i<list.length;i++){if(normStatus(list[i].status)==="in_progress")return list[i].id;}for(i=0;i<list.length;i++){var st=normStatus(list[i].status);if(st!=="done"&&st!=="skipped")return list[i].id;}return list.length?list[0].id:null;}' +
    'function statusBadge(st){var s=normStatus(st);return"<span class=\\"tl-badge tl-badge-"+s+"\\">"+(STATUS_MAP[s]||s)+"</span>";}' +
    'function statusOptions(sel){var h="";STATUSES.forEach(function(p){h+="<option value=\\""+p[0]+"\\""+(sel===p[0]?" selected":"")+">"+p[1]+"</option>";});return h;}' +
    'function stageOptions(sel){var h="";STAGES.forEach(function(s){h+="<option value=\\""+s.id+"\\""+(sel===s.id?" selected":"")+">"+s.label+"</option>";});return h;}' +
    'function loadOverviewUi(){var o=readOverview();var collapsed=!!o.overviewCollapsed;if(overviewCol)overviewCol.classList.toggle("is-collapsed",collapsed);if(collapseBtn){collapseBtn.disabled=collapsed;collapseBtn.setAttribute("aria-expanded",collapsed?"false":"true");}if(expandBtn){expandBtn.disabled=!collapsed;expandBtn.setAttribute("aria-expanded",collapsed?"true":"false");}}' +
    'function setOverviewCollapsed(c){var o=readOverview();o.overviewCollapsed=!!c;writeOverview(o);loadOverviewUi();}' +
    'function loadManageUi(){var o=readOverview();var c=!!o.manageCollapsed;if(manageWrap)manageWrap.classList.toggle("is-collapsed",c);if(manageToggle){manageToggle.textContent=c?"+ Add & manage":"Hide add & list";manageToggle.setAttribute("aria-expanded",c?"false":"true");}}' +
    'function setManageCollapsed(c){var o=readOverview();o.manageCollapsed=!!c;writeOverview(o);loadManageUi();if(!c&&inpTitle)setTimeout(function(){inpTitle.focus();},50);}' +
    'function formatDate(d){var s=String(d||"").trim();if(!s)return"—";try{var p=s.split("-");if(p.length>=3)return parseInt(p[2],10)+"/"+parseInt(p[1],10);}catch(e){}return s;}' +
    'function updateItem(id,patch){var o=readOverview();var it=null;o.items.forEach(function(x){if(String(x.id)===String(id))it=x;});if(it)Object.assign(it,patch);writeOverview(o);render();}' +
    'function removeItem(id){var o=readOverview();o.items=o.items.filter(function(it){return String(it.id)!==String(id);});writeOverview(o);render();}' +
    'function addItem(){var title=inpTitle?String(inpTitle.value||"").trim():"";if(!title){if(inpTitle)inpTitle.focus();return;}var o=readOverview();o.items.push({id:nextId(),stage:inpStage?inpStage.value:"learning",title:title,detail:inpDetail?String(inpDetail.value||"").trim():"",date:inpDate?String(inpDate.value||"").trim():"",status:inpStatus?normStatus(inpStatus.value):"not_started"});writeOverview(o);if(inpTitle)inpTitle.value="";if(inpDetail)inpDetail.value="";if(inpDate)inpDate.value="";if(inpStatus)inpStatus.value="not_started";render();if(inpTitle)inpTitle.focus();}' +
    'function renderOverview(){var o=readOverview();var items=sortedItems(o.items);var currentId=pickCurrentId(items);var done=0;items.forEach(function(it){if(normStatus(it.status)==="done")done++;});if(labelEl)labelEl.textContent=items.length?done+" / "+items.length+" milestones on your path":"Career overview";if(nowEl){var cur=currentId?items.filter(function(it){return it.id===currentId;})[0]:null;nowEl.classList.toggle("is-in-progress-active",!!(cur&&normStatus(cur.status)==="in_progress"));nowEl.innerHTML=cur?"Now: <strong>"+String(cur.title||"Entry").replace(/</g,"&lt;")+"</strong> · "+String(stageLabel(cur.stage)).replace(/</g,"&lt;"):"Add entries below — your path appears here.";}host.innerHTML="";if(!items.length){host.innerHTML=\'<p class="da-overview-empty-route">Your timeline is empty. Add learning, certifications, projects, or job applications below.</p>\';return;}var wrap=document.createElement("div");wrap.className="tl-route";wrap.setAttribute("role","list");var lastStage=null;items.forEach(function(it){var st=normStatus(it.status);if(it.stage!==lastStage){lastStage=it.stage;var ph=document.createElement("div");ph.className="tl-stop is-phase";ph.setAttribute("role","listitem");var timeEl=document.createElement("div");timeEl.className="tl-stop-time";timeEl.textContent="";var track=document.createElement("div");track.className="tl-stop-track";var dot=document.createElement("span");dot.className="tl-stop-dot";dot.setAttribute("aria-hidden","true");track.appendChild(dot);var body=document.createElement("div");body.className="tl-stop-body";var title=document.createElement("p");title.className="tl-stop-title";title.textContent=stageLabel(it.stage);var meta=document.createElement("p");meta.className="tl-stop-meta";STAGES.forEach(function(s){if(s.id===it.stage)meta.textContent=s.hint;});body.appendChild(title);body.appendChild(meta);ph.appendChild(timeEl);ph.appendChild(track);ph.appendChild(body);wrap.appendChild(ph);}var stop=document.createElement("div");stop.className="tl-stop is-entry";if(it.id===currentId)stop.classList.add("is-current");if(st==="in_progress")stop.classList.add("is-in-progress");if(st==="done")stop.classList.add("is-done");if(st==="skipped")stop.classList.add("is-skipped");stop.setAttribute("role","listitem");stop.setAttribute("data-id",it.id);var timeEl2=document.createElement("div");timeEl2.className="tl-stop-time";timeEl2.textContent=formatDate(it.date);var track2=document.createElement("div");track2.className="tl-stop-track";var dot2=document.createElement("span");dot2.className="tl-stop-dot";dot2.setAttribute("aria-hidden","true");var line2=document.createElement("span");line2.className="tl-stop-line";line2.setAttribute("aria-hidden","true");track2.appendChild(dot2);track2.appendChild(line2);var body2=document.createElement("div");body2.className="tl-stop-body";var title2=document.createElement("p");title2.className="tl-stop-title";title2.textContent=String(it.title||"Entry");var meta2=document.createElement("p");meta2.className="tl-stop-meta";meta2.textContent=[STATUS_MAP[st]||st,it.detail||""].filter(Boolean).join(" · ");body2.appendChild(title2);body2.appendChild(meta2);stop.appendChild(timeEl2);stop.appendChild(track2);stop.appendChild(body2);wrap.appendChild(stop);});host.appendChild(wrap);}' +
    'function appendEntryRow(it,isEdit){var tr=document.createElement("tr");tr.setAttribute("data-id",it.id);if(normStatus(it.status)==="done")tr.className="tl-row-done";var tdDate=document.createElement("td");tdDate.className="tl-col-time";tdDate.textContent=formatDate(it.date);var tdTitle=document.createElement("td");var tdStage=document.createElement("td");var tdStatus=document.createElement("td");if(isEdit){var inpT=document.createElement("input");inpT.type="text";inpT.className="tl-task-text";inpT.value=String(it.title||"");inpT.placeholder="Title";tdTitle.appendChild(inpT);var inpD=document.createElement("input");inpD.type="text";inpD.className="tl-task-detail";inpD.value=String(it.detail||"");inpD.placeholder="Detail";tdTitle.appendChild(inpD);var selSt=document.createElement("select");selSt.className="tl-task-stage";selSt.innerHTML=stageOptions(it.stage);tdStage.appendChild(selSt);var selStatus=document.createElement("select");selStatus.className="tl-task-status";selStatus.innerHTML=statusOptions(normStatus(it.status));tdStatus.appendChild(selStatus);}else{var viewText=document.createElement("span");viewText.className="tl-view-text";viewText.textContent=String(it.title||"").trim()||"Untitled";tdTitle.appendChild(viewText);if(String(it.detail||"").trim()){var det=document.createElement("span");det.className="tl-view-detail";det.textContent=String(it.detail);tdTitle.appendChild(det);}tdStage.textContent=stageLabel(it.stage);tdStatus.innerHTML=statusBadge(it.status);}var tdAct=document.createElement("td");tdAct.className="tl-td-actions";var actWrap=document.createElement("div");actWrap.className="tl-actions";if(isEdit){actWrap.appendChild(makeIconBtn("tl-save","Save entry",SVG_CHECK));actWrap.appendChild(makeIconBtn("tl-cancel","Cancel editing",SVG_X));}else{actWrap.appendChild(makeIconBtn("tl-edit","Edit entry",SVG_PENCIL));var btnDone=makeIconBtn("tl-done","Mark as done",SVG_MARK_DONE);if(normStatus(it.status)==="done"){btnDone.disabled=true;btnDone.classList.add("is-active");}actWrap.appendChild(btnDone);actWrap.appendChild(makeIconBtn("tl-remove","Remove entry",SVG_TRASH));}tdAct.appendChild(actWrap);tr.appendChild(tdDate);tr.appendChild(tdTitle);tr.appendChild(tdStage);tr.appendChild(tdStatus);tr.appendChild(tdAct);tbody.appendChild(tr);if(isEdit){var focusText=tr.querySelector(".tl-task-text");if(focusText)focusText.focus();}}' +
    'function renderTable(){var o=readOverview();if(editingId&&!o.items.some(function(it){return String(it.id)===String(editingId);}))editingId=null;tbody.innerHTML="";var shown=0;var lastStage=null;sortedItems(o.items).forEach(function(it){if(it.stage!==lastStage){lastStage=it.stage;var trH=document.createElement("tr");trH.className="tl-row-section";var tdH=document.createElement("td");tdH.colSpan=5;tdH.textContent=stageLabel(it.stage);trH.appendChild(tdH);tbody.appendChild(trH);}shown++;appendEntryRow(it,editingId===it.id);});if(emptyEl)emptyEl.hidden=shown>0;}' +
    'function render(){loadOverviewUi();loadManageUi();renderOverview();renderTable();}' +
    'function saveEditingRow(tr){if(!tr)return;var id=tr.getAttribute("data-id");var inpT=tr.querySelector(".tl-task-text");var inpD=tr.querySelector(".tl-task-detail");var selSt=tr.querySelector(".tl-task-stage");var selStatus=tr.querySelector(".tl-task-status");var title=inpT?String(inpT.value||"").trim():"";if(!title){if(inpT)inpT.focus();return;}editingId=null;updateItem(id,{title:title,detail:inpD?String(inpD.value||"").trim():"",stage:selSt?selSt.value:"learning",status:selStatus?normStatus(selStatus.value):"not_started"});}' +
    'if(addBtn)addBtn.addEventListener("click",addItem);' +
    'if(inpTitle)inpTitle.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();addItem();}});' +
    'tbody.addEventListener("keydown",function(e){var tr=e.target.closest("tr[data-id]");if(!tr||editingId!==tr.getAttribute("data-id"))return;if(e.key==="Enter"&&e.target.classList.contains("tl-task-text")){e.preventDefault();saveEditingRow(tr);}else if(e.key==="Escape"){e.preventDefault();editingId=null;render();}});' +
    'tbody.addEventListener("click",function(e){var tr=e.target.closest("tr[data-id]");if(!tr)return;var id=tr.getAttribute("data-id");if(e.target.closest(".tl-edit")){editingId=id;render();return;}if(e.target.closest(".tl-done")){updateItem(id,{status:"done"});return;}if(e.target.closest(".tl-save")){saveEditingRow(tr);return;}if(e.target.closest(".tl-cancel")){editingId=null;render();return;}if(e.target.closest(".tl-remove")){if(editingId===id)editingId=null;removeItem(id);}});' +
    'if(collapseBtn)collapseBtn.addEventListener("click",function(){setOverviewCollapsed(true);});' +
    'if(expandBtn)expandBtn.addEventListener("click",function(){setOverviewCollapsed(false);});' +
    'if(manageToggle)manageToggle.addEventListener("click",function(){var o=readOverview();setManageCollapsed(!o.manageCollapsed);});' +
    'host.addEventListener("click",function(e){var stop=e.target.closest(".tl-stop.is-entry");if(!stop)return;var id=stop.getAttribute("data-id");var tr=tbody.querySelector(\'tr[data-id="\'+id+\'"]\');if(tr){tr.scrollIntoView({behavior:"smooth",block:"nearest"});tr.classList.add("tl-row-focus");setTimeout(function(){tr.classList.remove("tl-row-focus");},1200);}});' +
    'try{var qs=new URLSearchParams(location.search);if(qs.get("title")&&inpTitle){inpTitle.value=String(qs.get("title")||"");if(inpDetail&&qs.get("detail"))inpDetail.value=String(qs.get("detail")||"");if(inpDate&&qs.get("date"))inpDate.value=String(qs.get("date")||"");if(inpStage&&qs.get("stage"))inpStage.value=String(qs.get("stage")||"");history.replaceState(null,"",location.pathname);}}catch(e){}' +
    'wsGet(OV_SK,function(err,d){_ovCache=normOverview(d||defaultOverview());if(!d)writeOverview(_ovCache);render();});' +
    '})();<' +
    '/script>'
  );
}


function buildCareerOverviewHtml(deps) {
  deps = deps || {};
  const {
    getTlListStyles,
    escAttr,
    escHtml,
    statuses,
    stages = CAREER_STAGES,
    storageKey = OVERVIEW_STORAGE_KEY,
    pageTitle = 'Data analytics',
    pageSub = 'Career overview — learning through certifications, projects, and job search.',
    subNavHtml = '',
    toolbarActionsHtml = '',
    titlePlaceholder = 'e.g. Google Data Analytics cert'
  } = deps;
  const script = buildOverviewClientScript(statuses || [], { storageKey, stages });
  const stageOpts = stages
    .map((s) => '<option value="' + escAttr(s.id) + '">' + escHtml(s.label) + '</option>')
    .join('');
  const statusOpts = (statuses || [])
    .map(([v, lab]) => '<option value="' + escAttr(v) + '">' + escHtml(lab) + '</option>')
    .join('');

  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>' +
    escHtml(pageTitle) +
    '</h1>' +
    '<p class="sub">' +
    escHtml(pageSub) +
    '</p>' +
    subNavHtml +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    toolbarActionsHtml +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tl-panel tl-career">' +
    getTlListStyles() +
    getTlCareerExtraStyles() +
    '<div class="tl-dayhead">' +
    '<div><h2 id="da-overview-label">Career overview</h2><p>Your path is saved in this browser. Add milestones below.</p></div>' +
    '</div>' +
    '<p class="tl-hint">Track learning, certifications, practical work, and job applications. Hide the add form and list when you only need the timeline.</p>' +
    '<div class="da-overview-main">' +
    '<aside class="tl-overview-col" id="da-overview-col" aria-label="Career overview">' +
    '<div class="tl-overview-head">' +
    '<h3>Career path</h3>' +
    '<div class="tl-overview-toggles">' +
    '<button type="button" id="da-overview-collapse" class="tl-overview-toggle" aria-label="Collapse overview" aria-controls="da-overview-body" aria-expanded="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg></button>' +
    '<button type="button" id="da-overview-expand" class="tl-overview-toggle" aria-label="Expand overview" aria-controls="da-overview-body" aria-expanded="false" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>' +
    '</div></div>' +
    '<div id="da-overview-body" class="tl-overview-body">' +
    '<p id="da-overview-now" class="tl-overview-now">Add entries below — your path appears here.</p>' +
    '<div id="da-career-host"></div>' +
    '</div></aside>' +
    '</div>' +
    '<div class="da-manage-wrap" id="da-manage-wrap">' +
    '<div class="da-manage-bar">' +
    '<button type="button" id="da-manage-toggle" class="da-manage-toggle" aria-expanded="true" aria-controls="da-manage-body">Hide add &amp; list</button>' +
    '</div>' +
    '<div id="da-manage-body" class="da-manage-body">' +
    '<div class="tl-add">' +
    '<div class="tl-field"><label for="da-ov-stage">Stage</label><select id="da-ov-stage">' +
    stageOpts +
    '</select></div>' +
    '<div class="tl-field"><label for="da-ov-title">Title</label><input type="text" id="da-ov-title" autocomplete="off" placeholder="' +
    escAttr(titlePlaceholder) +
    '" /></div>' +
    '<div class="tl-field"><label for="da-ov-detail">Detail</label><input type="text" id="da-ov-detail" autocomplete="off" placeholder="Optional notes" /></div>' +
    '<div class="tl-field"><label for="da-ov-date">Date</label><input type="date" id="da-ov-date" /></div>' +
    '<div class="tl-field"><label for="da-ov-status">Status</label><select id="da-ov-status">' +
    statusOpts +
    '</select></div>' +
    '<div class="tl-field"><label>&nbsp;</label><button type="button" id="da-ov-add-btn" class="tl-btn-add">+ Add</button></div>' +
    '</div>' +
    '<div class="tl-table-wrap">' +
    '<table class="tl-table" aria-label="Career milestones">' +
    '<thead><tr><th class="tl-col-time">Date</th><th>Title</th><th>Stage</th><th>Status</th><th></th></tr></thead>' +
    '<tbody id="da-tbody"></tbody>' +
    '</table>' +
    '<p id="da-empty" class="tl-empty" hidden>No entries yet.</p>' +
    '</div>' +
    '</div></div>' +
    script +
    '</div></div>'
  );
}

function buildDataAnalyticsOverviewHtml(deps) {
  const subNav = deps.dataAnalyticsSubNavHtml
    ? deps.dataAnalyticsSubNavHtml('/data-analytics/overview')
    : '';
  return buildCareerOverviewHtml({
    ...deps,
    subNavHtml: subNav,
    pageTitle: 'Data analytics',
    pageSub: 'Career overview — learning through certifications, projects, and job search.',
    toolbarActionsHtml:
      '<a class="link-pill" href="/">Home</a>' +
      '<a class="link-pill" href="/data-analytics/learning">Learning track</a>'
  });
}

function buildStudyingMedicalPhysicsOverviewHtml(deps) {
  const subNav = deps.medicalPhysicsSubNavHtml
    ? deps.medicalPhysicsSubNavHtml('/studying-medical-physics/career-overview')
    : '';
  return buildCareerOverviewHtml({
    ...deps,
    storageKey: MEDICAL_PHYSICS_OVERVIEW_STORAGE_KEY,
    subNavHtml: subNav,
    pageTitle: 'Studying medical physics',
    pageSub: 'Career overview — learning through certifications, projects, and job search.',
    toolbarActionsHtml:
      '<a class="link-pill" href="/">Home</a>' +
      '<a class="link-pill" href="/studying-medical-physics">Study board</a>',
    titlePlaceholder: 'e.g. CAMPEP prerequisite course'
  });
}



const HIGH_YIELD_STORAGE_KEY = 'secondBrainDataAnalyticsHighYieldV1';

function getTlHighYieldExtraStyles() {
  return (
    '<style>' +
    '.tl-high-yield .tl-add{margin:0 0 16px;}' +
    '@media(min-width:720px){.tl-high-yield .tl-add{grid-template-columns:1.4fr 1.2fr 9.5rem auto;}}' +
    '.tl-high-yield .tl-table th:nth-child(2){width:9.5rem;}' +
    '.tl-high-yield .tl-table th:nth-child(3){width:8.75rem;text-align:right;}' +
    '.tl-high-yield .tl-view-detail{display:block;font-size:12px;color:#64748b;margin-top:4px;}' +
    '.tl-high-yield .tl-task-detail{margin-top:6px;}' +
    '.tl-high-yield .tl-task-detail,.tl-high-yield .tl-task-text{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:13px;}' +
    '</style>'
  );
}

function buildHighYieldActivityClientScript(statuses) {
  return (
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var _hyCache=null;' +
    'var STATUSES=' +
    JSON.stringify(statuses || []) +
    ';' +
    'var STATUS_MAP={};STATUSES.forEach(function(p){STATUS_MAP[p[0]]=p[1];});' +
    'var HY_SK=' +
    JSON.stringify(HIGH_YIELD_STORAGE_KEY) +
    ';' +
    'var SVG_PENCIL=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>\';' +
    'var SVG_TRASH=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>\';' +
    'var SVG_MARK_DONE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9" stroke-linecap="round" stroke-linejoin="round"/></svg>\';' +
    'var SVG_CHECK=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>\';' +
    'var SVG_X=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>\';' +
    'function makeIconBtn(cls,label,svg){var b=document.createElement("button");b.type="button";b.className="tl-icon-btn "+cls;b.setAttribute("aria-label",label);b.innerHTML=svg;return b;}' +
    'var editingId=null;' +
    'var tbody=document.getElementById("hy-tbody");' +
    'var emptyEl=document.getElementById("hy-empty");' +
    'var labelEl=document.getElementById("hy-label");' +
    'var inpTitle=document.getElementById("hy-title");' +
    'var inpDetail=document.getElementById("hy-detail");' +
    'var inpStatus=document.getElementById("hy-status");' +
    'var addBtn=document.getElementById("hy-add-btn");' +
    'if(!tbody)return;' +
    'function nextId(){return"hy"+Date.now()+Math.random().toString(36).slice(2,9);}' +
    'function normStatus(s){var v=String(s||"").trim();for(var i=0;i<STATUSES.length;i++){if(STATUSES[i][0]===v)return v;}return"not_started";}' +
    'function defaultHy(){return{version:1,items:[]};}' +
    'function normHy(o){if(!o||typeof o!=="object"||!Array.isArray(o.items))return defaultHy();return o;}' +
    'function readStore(){if(_hyCache)return _hyCache;return defaultHy();}' +
    'function writeStore(o){_hyCache=normHy(o);wsPut(HY_SK,_hyCache);}' +
    'function statusBadge(st){var s=normStatus(st);return"<span class=\\"tl-badge tl-badge-"+s+"\\">"+(STATUS_MAP[s]||s)+"</span>";}' +
    'function statusOptions(sel){var h="";STATUSES.forEach(function(p){h+="<option value=\\""+p[0]+"\\""+(sel===p[0]?" selected":"")+">"+p[1]+"</option>";});return h;}' +
    'function updateItem(id,patch){var o=readStore();var it=null;o.items.forEach(function(x){if(String(x.id)===String(id))it=x;});if(it)Object.assign(it,patch);writeStore(o);render();}' +
    'function removeItem(id){var o=readStore();o.items=o.items.filter(function(it){return String(it.id)!==String(id);});writeStore(o);render();}' +
    'function addItem(){var title=inpTitle?String(inpTitle.value||"").trim():"";if(!title){if(inpTitle)inpTitle.focus();return;}var o=readStore();o.items.push({id:nextId(),title:title,detail:inpDetail?String(inpDetail.value||"").trim():"",status:inpStatus?normStatus(inpStatus.value):"not_started"});writeStore(o);if(inpTitle)inpTitle.value="";if(inpDetail)inpDetail.value="";if(inpStatus)inpStatus.value="not_started";render();if(inpTitle)inpTitle.focus();}' +
    'function appendRow(it,isEdit){var tr=document.createElement("tr");tr.setAttribute("data-id",it.id);if(normStatus(it.status)==="done")tr.className="tl-row-done";var tdTitle=document.createElement("td");var tdStatus=document.createElement("td");if(isEdit){var inpT=document.createElement("input");inpT.type="text";inpT.className="tl-task-text";inpT.value=String(it.title||"");inpT.placeholder="Activity";tdTitle.appendChild(inpT);var inpD=document.createElement("input");inpD.type="text";inpD.className="tl-task-detail";inpD.value=String(it.detail||"");inpD.placeholder="Why it is high yield";tdTitle.appendChild(inpD);var selStatus=document.createElement("select");selStatus.className="tl-task-status";selStatus.innerHTML=statusOptions(normStatus(it.status));tdStatus.appendChild(selStatus);}else{var viewText=document.createElement("span");viewText.className="tl-view-text";viewText.textContent=String(it.title||"").trim()||"Untitled";tdTitle.appendChild(viewText);if(String(it.detail||"").trim()){var det=document.createElement("span");det.className="tl-view-detail";det.textContent=String(it.detail);tdTitle.appendChild(det);}tdStatus.innerHTML=statusBadge(it.status);}var tdAct=document.createElement("td");tdAct.className="tl-td-actions";var actWrap=document.createElement("div");actWrap.className="tl-actions";if(isEdit){actWrap.appendChild(makeIconBtn("tl-save","Save activity",SVG_CHECK));actWrap.appendChild(makeIconBtn("tl-cancel","Cancel editing",SVG_X));}else{actWrap.appendChild(makeIconBtn("tl-edit","Edit activity",SVG_PENCIL));var btnDone=makeIconBtn("tl-done","Mark as done",SVG_MARK_DONE);if(normStatus(it.status)==="done"){btnDone.disabled=true;btnDone.classList.add("is-active");}actWrap.appendChild(btnDone);actWrap.appendChild(makeIconBtn("tl-remove","Remove activity",SVG_TRASH));}tdAct.appendChild(actWrap);tr.appendChild(tdTitle);tr.appendChild(tdStatus);tr.appendChild(tdAct);tbody.appendChild(tr);if(isEdit){var focusText=tr.querySelector(".tl-task-text");if(focusText)focusText.focus();}}' +
    'function render(){var o=readStore();if(editingId&&!o.items.some(function(it){return String(it.id)===String(editingId);}))editingId=null;tbody.innerHTML="";var done=0;o.items.forEach(function(it){if(normStatus(it.status)==="done")done++;});if(labelEl)labelEl.textContent=o.items.length?done+" / "+o.items.length+" activities done":"High yield activity";o.items.forEach(function(it){appendRow(it,editingId===it.id);});if(emptyEl)emptyEl.hidden=o.items.length>0;}' +
    'function saveEditingRow(tr){if(!tr)return;var id=tr.getAttribute("data-id");var inpT=tr.querySelector(".tl-task-text");var inpD=tr.querySelector(".tl-task-detail");var selStatus=tr.querySelector(".tl-task-status");var title=inpT?String(inpT.value||"").trim():"";if(!title){if(inpT)inpT.focus();return;}editingId=null;updateItem(id,{title:title,detail:inpD?String(inpD.value||"").trim():"",status:selStatus?normStatus(selStatus.value):"not_started"});}' +
    'if(addBtn)addBtn.addEventListener("click",addItem);' +
    'if(inpTitle)inpTitle.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();addItem();}});' +
    'tbody.addEventListener("keydown",function(e){var tr=e.target.closest("tr[data-id]");if(!tr||editingId!==tr.getAttribute("data-id"))return;if(e.key==="Enter"&&e.target.classList.contains("tl-task-text")){e.preventDefault();saveEditingRow(tr);}else if(e.key==="Escape"){e.preventDefault();editingId=null;render();}});' +
    'tbody.addEventListener("click",function(e){var tr=e.target.closest("tr[data-id]");if(!tr)return;var id=tr.getAttribute("data-id");if(e.target.closest(".tl-edit")){editingId=id;render();return;}if(e.target.closest(".tl-done")){updateItem(id,{status:"done"});return;}if(e.target.closest(".tl-save")){saveEditingRow(tr);return;}if(e.target.closest(".tl-cancel")){editingId=null;render();return;}if(e.target.closest(".tl-remove")){if(editingId===id)editingId=null;removeItem(id);}});' +
    'wsGet(HY_SK,function(err,d){_hyCache=normHy(d||defaultHy());if(!d)writeStore(_hyCache);render();});' +
    '})();<' +
    '/script>'
  );
}

function buildHighYieldActivityHtml(deps) {
  const { getTlListStyles, escAttr, escHtml, statuses } = deps;
  const statusOpts = (statuses || [])
    .map(([v, lab]) => '<option value="' + escAttr(v) + '">' + escHtml(lab) + '</option>')
    .join('');
  const script = buildHighYieldActivityClientScript(statuses || []);

  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>High yield activity</h1>' +
    '<p class="sub">Focus on work that moves your data career forward fastest—saved in this browser.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/todolist">Todo list</a>' +
    '<a class="link-pill" href="/daily-tasks">Daily tasks</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tl-panel tl-high-yield">' +
    getTlListStyles() +
    getTlHighYieldExtraStyles() +
    '<div class="tl-dayhead">' +
    '<div><h2 id="hy-label">High yield activity</h2><p>Track the activities that give you the most return on time. Saved in this browser.</p></div>' +
    '</div>' +
    '<p class="tl-hint">Add study blocks, projects, networking, or practice that compounds. Mark done when complete.</p>' +
    '<div class="tl-add">' +
    '<div class="tl-field"><label for="hy-title">Activity</label><input type="text" id="hy-title" autocomplete="off" placeholder="e.g. Build portfolio project" /></div>' +
    '<div class="tl-field"><label for="hy-detail">Why high yield</label><input type="text" id="hy-detail" autocomplete="off" placeholder="Optional — impact or outcome" /></div>' +
    '<div class="tl-field"><label for="hy-status">Status</label><select id="hy-status">' +
    statusOpts +
    '</select></div>' +
    '<div class="tl-field"><label>&nbsp;</label><button type="button" id="hy-add-btn" class="tl-btn-add">+ Add</button></div>' +
    '</div>' +
    '<div class="tl-table-wrap">' +
    '<table class="tl-table" aria-label="High yield activities">' +
    '<thead><tr><th>Activity</th><th>Status</th><th></th></tr></thead>' +
    '<tbody id="hy-tbody"></tbody>' +
    '</table>' +
    '<p id="hy-empty" class="tl-empty" hidden>No activities yet.</p>' +
    '</div>' +
    script +
    '</div></div>'
  );
}

const JOB_BOARD_STORAGE_KEY = 'secondBrainDataAnalyticsJobBoardV1';

function getTlJobBoardExtraStyles() {
  return (
    '<style>' +
    '.tl-job-board .tl-add{margin:0 0 18px;}' +
    '@media(min-width:900px){.tl-job-board .tl-add{grid-template-columns:repeat(4,minmax(0,1fr)) auto;}}' +
    '@media(min-width:720px) and (max-width:899px){.tl-job-board .tl-add{grid-template-columns:repeat(2,minmax(0,1fr));}}' +
    '.tl-job-board .tl-table{min-width:1080px;}' +
    '.tl-job-board .tl-table th:nth-child(10){width:7.5rem;text-align:right;}' +
    '.jb-status-wrap{display:flex;flex-wrap:wrap;gap:6px;}' +
    '.jb-status-btn{border:1px solid #e2e8f0;background:#f8fafc;color:#475569;border-radius:999px;padding:5px 10px;font:inherit;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;}' +
    '.jb-status-btn.is-active{background:#0d9488;border-color:#0d9488;color:#fff;}' +
    '.jb-status-btn.is-active[data-status="assessing"]{background:#d97706;border-color:#d97706;}' +
    '.jb-status-btn:hover:not(.is-active){background:#f0fdfa;border-color:#99f6e4;color:#0f766e;}' +
    '.jb-closed-alert{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px;padding:12px 16px;border-radius:10px;border:1px solid #fcd34d;background:#fffbeb;color:#92400e;font-size:13px;}' +
    '.jb-closed-alert-link{font-weight:700;color:#b45309;text-decoration:none;white-space:nowrap;}' +
    '.jb-closed-alert-link:hover{text-decoration:underline;}' +
    '.tl-job-board tr.tl-row-closed-assessing td{background:#fff7ed;}' +
    '.jb-closing-countdown{display:block;margin-top:3px;font-size:11px;font-weight:600;color:#b45309;}' +
    '.jb-closing-countdown.is-soon{color:#0f766e;}' +
    '.jb-closing-countdown.is-past{color:#64748b;font-weight:500;}' +
    '.jb-account-select{max-width:12rem;font-size:11px;padding:5px 8px;}' +
    '.jb-resume-wrap{display:flex;flex-direction:column;gap:4px;min-width:9rem;}' +
    '.jb-resume-select{max-width:12rem;font-size:11px;padding:5px 8px;}' +
    '.jb-resume-upload{font-size:11px;max-width:12rem;}' +
    '.tl-job-board .jb-inp{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:12px;}' +
    '.tl-job-board .jb-inp:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 2px rgba(13,148,136,0.12);}' +
    '.tl-job-board .jb-link{color:#0f766e;font-weight:600;text-decoration:none;word-break:break-all;}' +
    '.tl-job-board .jb-link:hover{text-decoration:underline;}' +
    '.tl-job-board .jb-meta{font-size:11px;color:#64748b;font-variant-numeric:tabular-nums;}' +
    '.tl-job-board tr.tl-row-flagged td{background:#fffbeb;}' +
    '.tl-job-board tr.tl-row-flagged .tl-view-text{color:#92400e;}' +
    '.tl-icon-btn.tl-flag:hover{background:#fffbeb;border-color:#fcd34d;color:#b45309;}' +
    '.tl-icon-btn.tl-flag.is-active{background:#fef3c7;border-color:#fbbf24;color:#b45309;}' +
    '.jb-stats{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 18px;}' +
    '.jb-stat-card{flex:1;min-width:7.5rem;padding:14px 16px;border-radius:10px;border:1px solid #e2e8f0;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.04);}' +
    '.jb-stat-value{font-size:28px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;color:#0f172a;}' +
    '.jb-stat-label{font-size:11px;font-weight:700;color:#64748b;margin-top:6px;text-transform:uppercase;letter-spacing:0.05em;}' +
    '.jb-stat-card.is-applied{border-color:#99f6e4;background:#f0fdfa;}.jb-stat-card.is-applied .jb-stat-value{color:#0f766e;}' +
    '.jb-stat-card.is-closed{border-color:#e2e8f0;background:#f8fafc;}.jb-stat-card.is-closed .jb-stat-value{color:#475569;}' +
    '.jb-stat-card.is-unapplied{border-color:#fde68a;background:#fffbeb;}.jb-stat-card.is-unapplied .jb-stat-value{color:#b45309;}' +
    '</style>'
  );
}

function buildJobBoardClientScript(opts) {
  const mode = opts && opts.mode === 'closed-assessing' ? 'closed-assessing' : 'all';
  return (
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var _jbCache=null,_jaCache=null;' +
    'var JB_MODE=' +
    JSON.stringify(mode) +
    ';' +
    'var JB_SK=' +
    JSON.stringify(JOB_BOARD_STORAGE_KEY) +
    ';' +
    'var JA_SK=' +
    JSON.stringify(JOB_ACCOUNTS_STORAGE_KEY) +
    ';' +
    'var SVG_PENCIL=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>\';' +
    'var SVG_TRASH=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>\';' +
    'var SVG_FLAG=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 22V4"/><path d="M4 4h11l-2 4 2 4H4"/></svg>\';' +
    'var SVG_NOTE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>\';' +
    'var SVG_CHECK=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>\';' +
    'var SVG_X=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>\';' +
    'function makeIconBtn(cls,label,svg){var b=document.createElement("button");b.type="button";b.className="tl-icon-btn "+cls;b.setAttribute("aria-label",label);b.innerHTML=svg;return b;}' +
    'var editingId=null;' +
    'var tbody=document.getElementById("jb-tbody");' +
    'var emptyEl=document.getElementById("jb-empty");' +
    'var labelEl=document.getElementById("jb-label");' +
    'var addBtn=document.getElementById("jb-add-btn");' +
    'var fName=document.getElementById("jb-job-name");' +
    'var fLink=document.getElementById("jb-link");' +
    'var fApplied=document.getElementById("jb-applied");' +
    'var fClosing=document.getElementById("jb-closing");' +
    'var fRate=document.getElementById("jb-rate");' +
    'var fResume=document.getElementById("jb-add-resume");' +
    'var fJobId=document.getElementById("jb-job-id");' +
    'var _rsCache={items:[]};' +
    'if(!tbody)return;' +
    'function nextId(){return"jb"+Date.now()+Math.random().toString(36).slice(2,9);}' +
    'function normAppStatus(s){var v=String(s||"").trim().toLowerCase();if(v==="applied")return"applied";if(v==="assessing")return"assessing";if(v==="unapplied")return"unapplied";return"";}' +
    'function parseDateKey(d){var s=String(d||"").trim();if(!s)return null;var p=s.split("-");if(p.length<3)return null;var y=parseInt(p[0],10),mo=parseInt(p[1],10)-1,da=parseInt(p[2],10);if(!isFinite(y)||!isFinite(mo)||!isFinite(da))return null;return new Date(y,mo,da);}' +
    'function todayStart(){var n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate());}' +
    'function isJobClosed(it){var cd=parseDateKey(it&&it.closingDate);if(!cd)return false;return cd<todayStart();}' +
    'function isClosedAssessing(it){return isJobClosed(it)&&normAppStatus(it.applicationStatus)==="assessing";}' +
    'function countClosedAssessing(items){var n=0;items.forEach(function(it){if(isClosedAssessing(it))n++;});return n;}' +
    'function computeJobStats(items){var applied=0,closed=0,notApplied=0;items.forEach(function(it){if(isJobClosed(it))closed++;if(!hasJobId(it))return;var st=normAppStatus(it.applicationStatus);if(st==="applied"||st==="assessing")applied++;else notApplied++;});return{applied:applied,closed:closed,notApplied:notApplied,total:items.length};}' +
    'function updateJobStats(stats){var elApplied=document.getElementById("jb-stat-applied");var elClosed=document.getElementById("jb-stat-closed");var elUnapplied=document.getElementById("jb-stat-unapplied");if(elApplied)elApplied.textContent=String(stats.applied);if(elClosed)elClosed.textContent=String(stats.closed);if(elUnapplied)elUnapplied.textContent=String(stats.notApplied);}' +
    'function normJob(j){if(!j||typeof j!=="object")return j;j.jobName=String(j.jobName||"");j.link=String(j.link||"");j.appliedDate=String(j.appliedDate||"");j.closingDate=String(j.closingDate||"");j.rate=String(j.rate||"");j.resumeFileId=String(j.resumeFileId||j.resumeId||"").trim();j.resumeId=j.resumeFileId;j.jobId=String(j.jobId||"");j.applicationStatus=normAppStatus(j.applicationStatus);j.accountId=String(j.accountId||"");j.notes=String(j.notes||"");j.notesOpen=!!j.notesOpen;j.flagged=!!j.flagged;return j;}' +
    'function hasJobId(it){return!!String(it&&it.jobId||"").trim();}' +
    'function defaultJa(){return{version:1,items:[]};}' +
    'function normJa(o){if(!o||typeof o!=="object"||!Array.isArray(o.items))return defaultJa();return o;}' +
    'function readAccountsStore(){if(_jaCache)return _jaCache;return defaultJa();}' +
    'function accountLabel(a){if(!a)return"";var n=String(a.siteName||"").trim();var u=String(a.username||"").trim();if(n&&u)return n+" · "+u;return n||u||"Account";}' +
    'function findAccount(id){var items=readAccountsStore().items;for(var i=0;i<items.length;i++){if(String(items[i].id)===String(id))return items[i];}return null;}' +
    'function defaultJb(){return{version:1,items:[]};}' +
    'function normJb(o){if(!o||typeof o!=="object"||!Array.isArray(o.items))return defaultJb();o.items=o.items.map(normJob);return o;}' +
    'function readStore(){if(!_jbCache)_jbCache=defaultJb();return _jbCache;}' +
    'function writeStore(o){_jbCache=normJb(o);console.log("[job-board] writeStore items="+(_jbCache.items?_jbCache.items.length:0));wsPut(JB_SK,_jbCache);}' +
    'function findItem(o,id){for(var i=0;i<o.items.length;i++){if(String(o.items[i].id)===String(id))return o.items[i];}return null;}' +
    'function updateItem(id,patch){var o=readStore();var it=findItem(o,id);if(it)Object.assign(it,patch);writeStore(o);render();}' +
    'function removeItem(id){var o=readStore();o.items=o.items.filter(function(it){return String(it.id)!==String(id);});writeStore(o);render();}' +
    'function formatDate(d){var s=String(d||"").trim();if(!s)return"—";try{var p=s.split("-");if(p.length>=3)return parseInt(p[2],10)+"/"+parseInt(p[1],10)+"/"+p[0];}catch(e){}return s;}' +
    'function daysUntilClosing(d){var cd=parseDateKey(d);if(!cd)return null;return Math.round((cd.getTime()-todayStart().getTime())/86400000);}' +
    'function formatClosingCountdown(d){var days=daysUntilClosing(d);if(days===null)return"";if(days>0)return days+(days===1?" day left before closing":" days left before closing");if(days===0)return"Closes today";var ago=-days;return"Closed "+ago+(ago===1?" day ago":" days ago");}' +
    'function appendClosingCell(td,it){var wrap=document.createElement("div");var dateEl=document.createElement("span");dateEl.className="jb-meta";dateEl.textContent=formatDate(it.closingDate);wrap.appendChild(dateEl);var showCountdown=JB_MODE==="closed-assessing"||normAppStatus(it.applicationStatus)==="assessing";if(showCountdown){var rel=formatClosingCountdown(it.closingDate);if(rel){var cd=document.createElement("span");cd.className="jb-closing-countdown";var days=daysUntilClosing(it.closingDate);if(days!==null&&days>0)cd.classList.add("is-soon");else if(days!==null&&days<0)cd.classList.add("is-past");cd.textContent=rel;wrap.appendChild(cd);}}td.appendChild(wrap);}' +
    'function sortByClosingDate(items){return items.slice().sort(function(a,b){var da=daysUntilClosing(a.closingDate),db=daysUntilClosing(b.closingDate);if(da===null&&db===null)return 0;if(da===null)return 1;if(db===null)return-1;return da-db;});}' +
    'function sortClosedAssessing(items){return items.slice().sort(function(a,b){var da=daysUntilClosing(a.closingDate),db=daysUntilClosing(b.closingDate);if(da===null&&db===null)return 0;if(da===null)return 1;if(db===null)return-1;return db-da;});}' +
    'function mkInp(val,ph,type){var inp=document.createElement("input");inp.type=type||"text";inp.className="jb-inp";inp.value=String(val||"");if(ph)inp.placeholder=ph;return inp;}' +
    'function readRowFields(tr){var stBtn=tr.querySelector(".jb-status-btn.is-active");return{jobName:(tr.querySelector(".jb-job-name")||{}).value||"",link:(tr.querySelector(".jb-link-inp")||{}).value||"",appliedDate:(tr.querySelector(".jb-applied")||{}).value||"",closingDate:(tr.querySelector(".jb-closing")||{}).value||"",rate:(tr.querySelector(".jb-rate")||{}).value||"",resumeFileId:(tr.querySelector(".jb-resume-select")||{}).value||"",jobId:(tr.querySelector(".jb-job-id")||{}).value||"",applicationStatus:stBtn?String(stBtn.getAttribute("data-status")||""):"",accountId:(tr.querySelector(".jb-account-select")||{}).value||""};}' +
    'function clearAddForm(){if(fName)fName.value="";if(fLink)fLink.value="";if(fApplied)fApplied.value="";if(fClosing)fClosing.value="";if(fRate)fRate.value="";if(fResume)fResume.value="";if(fJobId)fJobId.value="";}' +
    'function addItem(){console.log("[job-board] addItem start");var jobName=fName?String(fName.value||"").trim():"";if(!jobName){console.warn("[job-board] addItem blocked: empty job name");if(fName)fName.focus();return;}var before=readStore().items.length;var o=readStore();var rid=fResume?String(fResume.value||"").trim():"";var newJob=normJob({id:nextId(),jobName:jobName,link:fLink?String(fLink.value||"").trim():"",appliedDate:fApplied?String(fApplied.value||""):"",closingDate:fClosing?String(fClosing.value||""):"",rate:fRate?String(fRate.value||"").trim():"",resumeFileId:rid,jobId:fJobId?String(fJobId.value||"").trim():"",applicationStatus:"",accountId:"",notes:"",notesOpen:false,flagged:false});console.log("[job-board] addItem new job",newJob);o.items.push(newJob);writeStore(o);console.log("[job-board] addItem after push items="+o.items.length+" (was "+before+")");clearAddForm();render();console.log("[job-board] addItem render done, tbody rows="+(tbody?tbody.querySelectorAll("tr[data-id]").length:0));if(fName)fName.focus();if(addBtn){addBtn.disabled=true;console.log("[job-board] addItem PUT /api/board-store/"+JB_SK);fetch("/api/board-store/"+encodeURIComponent(JB_SK),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({payload:_jbCache})}).then(function(r){console.log("[job-board] addItem PUT status="+r.status);if(!r.ok)throw new Error("save failed "+r.status);return r.json();}).then(function(res){console.log("[job-board] addItem PUT ok",res);}).catch(function(err){console.error("[job-board] addItem PUT failed",err);alert("Could not save to database. Check MongoDB is running and refresh to retry.");}).finally(function(){addBtn.disabled=false;});}}' +
    'function appendStatusCell(td,it){if(!hasJobId(it)){td.innerHTML=\'<span class="jb-meta">—</span>\';return;}var wrap=document.createElement("div");wrap.className="jb-status-wrap";wrap.setAttribute("role","group");wrap.setAttribute("aria-label","Application status");var st=normAppStatus(it.applicationStatus);[["unapplied","Unapplied"],["applied","Applied"],["assessing","Assessing"]].forEach(function(pair){var val=pair[0],lab=pair[1];var btn=document.createElement("button");btn.type="button";btn.className="jb-status-btn"+(st===val?" is-active":"");btn.setAttribute("data-status",val);btn.setAttribute("data-id",it.id);btn.textContent=lab;wrap.appendChild(btn);});td.appendChild(wrap);}' +
    'function appendAccountCell(td,it){var st=normAppStatus(it.applicationStatus);if(st!=="applied"&&st!=="assessing"){td.innerHTML=\'<span class="jb-meta">—</span>\';return;}var accounts=readAccountsStore().items;var acct=findAccount(it.accountId);if(acct&&!accounts.some(function(a){return String(a.id)===String(acct.id);})){accounts=accounts.concat([acct]);}var sel=document.createElement("select");sel.className="jb-account-select jb-inp";sel.setAttribute("data-id",it.id);var opt0=document.createElement("option");opt0.value="";opt0.textContent=accounts.length?"Attach account…":"No accounts — add in Job accounts";sel.appendChild(opt0);accounts.forEach(function(a){var o=document.createElement("option");o.value=a.id;o.textContent=accountLabel(a);if(String(it.accountId)===String(a.id))o.selected=true;sel.appendChild(o);});td.appendChild(sel);}' +
    'function resumeById(id){var items=_rsCache&&Array.isArray(_rsCache.items)?_rsCache.items:[];for(var i=0;i<items.length;i++){if(String(items[i].id)===String(id))return items[i];}return null;}' +
    'function resumeLabel(id){var r=resumeById(id);if(!r)return"";return String(r.label||r.originalName||"Resume");}' +
    'function buildResumeSelect(sel,selected){sel.innerHTML="";var opt0=document.createElement("option");opt0.value="";opt0.textContent=_rsCache.items&&_rsCache.items.length?"Attach resume…":"Upload in Resume library";sel.appendChild(opt0);(_rsCache.items||[]).forEach(function(r){var o=document.createElement("option");o.value=r.id;var t=String(r.label||"Resume");if(r.jobTypes)t+=" — "+r.jobTypes;o.textContent=t;if(String(selected)===String(r.id))o.selected=true;sel.appendChild(o);});}' +
    'function populateAddResumeSelect(){if(fResume)buildResumeSelect(fResume,fResume.value);}' +
    'function loadResumes(cb){fetch("/api/resumes",{headers:{Accept:"application/json"}}).then(function(r){if(!r.ok)throw new Error("fail");return r.json();}).then(function(d){_rsCache=d&&Array.isArray(d.items)?{items:d.items}:{items:[]};populateAddResumeSelect();if(cb)cb();}).catch(function(){_rsCache={items:[]};populateAddResumeSelect();if(cb)cb();});}' +
    'function appendResumeCell(td,it,isEdit){var wrap=document.createElement("div");wrap.className="jb-resume-wrap";var rid=String(it.resumeFileId||it.resumeId||"").trim();if(isEdit){var sel=document.createElement("select");sel.className="jb-resume-select jb-inp";buildResumeSelect(sel,rid);var up=document.createElement("input");up.type="file";up.className="jb-resume-upload";up.accept=".pdf,.doc,.docx";up.setAttribute("data-id",it.id);wrap.appendChild(sel);wrap.appendChild(up);}else{if(rid){var lab=document.createElement("span");lab.className="tl-view-text";lab.textContent=resumeLabel(rid)||"Resume";wrap.appendChild(lab);var a=document.createElement("a");a.className="jb-link";a.href="/api/resumes/"+encodeURIComponent(rid)+"/download";a.textContent="Download";a.setAttribute("download","");wrap.appendChild(a);}else{var empty=document.createElement("span");empty.className="jb-meta";empty.textContent="—";wrap.appendChild(empty);}}td.appendChild(wrap);}' +
    'function appendRow(it,isEdit){var tr=document.createElement("tr");tr.setAttribute("data-id",it.id);if(it.flagged)tr.classList.add("tl-row-flagged");if(isClosedAssessing(it))tr.classList.add("tl-row-closed-assessing");function td(){return document.createElement("td");}var cells=[td(),td(),td(),td(),td(),td(),td(),td(),td(),td()];if(isEdit){cells[0].appendChild((function(){var i=mkInp(it.jobName,"Job name");i.className+=" jb-job-name";return i;})());cells[1].appendChild((function(){var i=mkInp(it.link,"https://…");i.className+=" jb-link-inp";return i;})());cells[2].appendChild((function(){var i=mkInp(it.appliedDate,"","date");i.className+=" jb-applied";return i;})());cells[3].appendChild((function(){var i=mkInp(it.closingDate,"","date");i.className+=" jb-closing";return i;})());cells[4].appendChild((function(){var i=mkInp(it.rate,"Rate");i.className+=" jb-rate";return i;})());appendResumeCell(cells[5],it,true);cells[6].appendChild((function(){var i=mkInp(it.jobId,"Job ID");i.className+=" jb-job-id";return i;})());appendStatusCell(cells[7],it);appendAccountCell(cells[8],it);}else{var t0=document.createElement("span");t0.className="tl-view-text";t0.textContent=String(it.jobName||"").trim()||"Untitled";cells[0].appendChild(t0);var link=String(it.link||"").trim();if(link){var a=document.createElement("a");a.className="jb-link";a.href=link;a.target="_blank";a.rel="noopener noreferrer";a.textContent=link.length>42?link.slice(0,42)+"…":link;cells[1].appendChild(a);}else cells[1].innerHTML=\'<span class="jb-meta">—</span>\';cells[2].innerHTML=\'<span class="jb-meta">\'+formatDate(it.appliedDate)+"</span>";appendClosingCell(cells[3],it);cells[4].innerHTML=\'<span class="jb-meta">\'+(String(it.rate||"").trim()||"—")+"</span>";appendResumeCell(cells[5],it,false);cells[6].innerHTML=\'<span class="jb-meta">\'+(String(it.jobId||"").trim()||"—")+"</span>";appendStatusCell(cells[7],it);appendAccountCell(cells[8],it);}var tdAct=cells[9];tdAct.className="tl-td-actions";var actWrap=document.createElement("div");actWrap.className="tl-actions";if(isEdit){actWrap.appendChild(makeIconBtn("tl-save","Save job",SVG_CHECK));actWrap.appendChild(makeIconBtn("tl-cancel","Cancel editing",SVG_X));}else{var btnNotes=makeIconBtn("tl-notes-btn","Notes",SVG_NOTE);btnNotes.setAttribute("data-id",it.id);if(it.notesOpen)btnNotes.classList.add("is-open");if(String(it.notes||"").trim())btnNotes.classList.add("has-content");actWrap.appendChild(btnNotes);var btnFlag=makeIconBtn("tl-flag","Toggle flag",SVG_FLAG);btnFlag.setAttribute("data-id",it.id);if(it.flagged)btnFlag.classList.add("is-active");actWrap.appendChild(btnFlag);actWrap.appendChild(makeIconBtn("tl-edit","Edit job",SVG_PENCIL));actWrap.appendChild(makeIconBtn("tl-remove","Delete job",SVG_TRASH));}tdAct.appendChild(actWrap);cells.forEach(function(c){tr.appendChild(c);});tbody.appendChild(tr);var trN=document.createElement("tr");trN.className="tl-row-notes";trN.setAttribute("data-for",it.id);if(!it.notesOpen)trN.hidden=true;var tdN=document.createElement("td");tdN.colSpan=10;var panel=document.createElement("div");panel.className="tl-task-notes-panel";var ta=document.createElement("textarea");ta.className="tl-notes-field tl-task-notes";ta.setAttribute("data-id",it.id);ta.value=String(it.notes||"");ta.placeholder="Notes — interview stages, contacts, follow-ups…";ta.spellcheck=true;panel.appendChild(ta);tdN.appendChild(panel);trN.appendChild(tdN);tbody.appendChild(trN);if(isEdit){var focusEl=tr.querySelector(".jb-job-name");if(focusEl)focusEl.focus();}}' +
    'function render(){var o=readStore();if(editingId&&!findItem(o,editingId))editingId=null;tbody.innerHTML="";var flagged=0;var list=o.items;if(JB_MODE==="closed-assessing"){list=list.filter(isClosedAssessing);list=sortClosedAssessing(list);}else{updateJobStats(computeJobStats(o.items));}list.forEach(function(it){if(it.flagged)flagged++;});if(labelEl){if(JB_MODE==="closed-assessing")labelEl.textContent=list.length?list.length+" closed · assessing":"Closed — under assessment";else labelEl.textContent=o.items.length?o.items.length+" job"+(o.items.length===1?"":"s")+(flagged?" · "+flagged+" flagged":""):"Job board";}list.forEach(function(it){appendRow(it,editingId===it.id);});if(emptyEl){if(JB_MODE==="closed-assessing"){emptyEl.textContent="No closed jobs under assessment. On the job board: add a closing date in the past, add a Job ID, set status to Assessing.";emptyEl.hidden=list.length>0;}else{emptyEl.hidden=o.items.length>0;}}}' +
    'function saveEditingRow(tr){if(!tr)return;var id=tr.getAttribute("data-id");var f=readRowFields(tr);var jobName=String(f.jobName||"").trim();if(!jobName){var el=tr.querySelector(".jb-job-name");if(el)el.focus();return;}var jobId=String(f.jobId||"").trim();var rid=String(f.resumeFileId||"").trim();var patch={jobName:jobName,link:String(f.link||"").trim(),appliedDate:String(f.appliedDate||""),closingDate:String(f.closingDate||""),rate:String(f.rate||"").trim(),resumeFileId:rid,resumeId:rid,jobId:jobId};if(!jobId){patch.applicationStatus="";patch.accountId="";}else{patch.applicationStatus=normAppStatus(f.applicationStatus);patch.accountId=patch.applicationStatus==="applied"||patch.applicationStatus==="assessing"?String(f.accountId||""):"";}editingId=null;updateItem(id,patch);}' +
    'if(addBtn)addBtn.addEventListener("click",function(){console.log("[job-board] + Add button clicked");addItem();});' +
    'if(fName)fName.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();console.log("[job-board] Enter in job name");addItem();}});' +
    'tbody.addEventListener("input",function(e){var ta=e.target.closest("textarea.tl-task-notes");if(!ta)return;var id=ta.getAttribute("data-id");if(!id)return;var o=readStore();var it=findItem(o,id);if(!it)return;it.notes=ta.value;writeStore(o);});' +
    'tbody.addEventListener("keydown",function(e){var tr=e.target.closest("tr[data-id]");if(!tr||editingId!==tr.getAttribute("data-id"))return;if(e.key==="Enter"&&e.target.classList.contains("jb-job-name")){e.preventDefault();saveEditingRow(tr);}else if(e.key==="Escape"){e.preventDefault();editingId=null;render();}});' +
    'tbody.addEventListener("change",function(e){if(e.target.classList.contains("jb-resume-upload")){var file=e.target.files&&e.target.files[0]?e.target.files[0]:null;var jid=e.target.getAttribute("data-id");if(!file||!jid)return;var fd=new FormData();fd.append("label",file.name);fd.append("jobTypes","");fd.append("file",file);fd.append("attachJobId",jid);fetch("/api/resumes",{method:"POST",body:fd}).then(function(r){if(!r.ok)throw new Error("up");return r.json();}).then(function(res){loadResumes(function(){updateItem(jid,{resumeFileId:res.item.id,resumeId:res.item.id});});}).catch(function(){alert("Resume upload failed");});e.target.value="";return;}if(e.target.classList.contains("jb-resume-select")){var row=e.target.closest("tr[data-id]");if(row){var jobId=row.getAttribute("data-id");if(jobId){var v=String(e.target.value||"").trim();updateItem(jobId,{resumeFileId:v,resumeId:v});}}return;}if(!e.target.classList.contains("jb-account-select"))return;var id=e.target.getAttribute("data-id");if(!id)return;updateItem(id,{accountId:String(e.target.value||"")});});' +
    'tbody.addEventListener("click",function(e){var tr=e.target.closest("tr[data-id]");if(!tr)return;var id=tr.getAttribute("data-id");var statusBtn=e.target.closest(".jb-status-btn");if(statusBtn){var st=String(statusBtn.getAttribute("data-status")||"");var patch={applicationStatus:st};if(st==="unapplied")patch.accountId="";updateItem(id,patch);return;}if(e.target.closest(".tl-notes-btn")){var o=readStore();var it=findItem(o,id);if(it)updateItem(id,{notesOpen:!it.notesOpen});return;}if(e.target.closest(".tl-flag")){var o2=readStore();var it2=findItem(o2,id);if(it2)updateItem(id,{flagged:!it2.flagged});return;}if(e.target.closest(".tl-edit")){editingId=id;render();return;}if(e.target.closest(".tl-save")){saveEditingRow(tr);return;}if(e.target.closest(".tl-cancel")){editingId=null;render();return;}if(e.target.closest(".tl-remove")){if(editingId===id)editingId=null;removeItem(id);}});' +
    'var _jbBoot=3;function jbReady(){if(--_jbBoot>0)return;populateAddResumeSelect();render();}' +
    'loadResumes(jbReady);' +
    'wsGet(JB_SK,function(e,d){var hadLocal=_jbCache&&Array.isArray(_jbCache.items)&&_jbCache.items.length>0;console.log("[job-board] wsGet load",{err:e,hasPayload:!!d,itemCount:d&&d.items?d.items.length:0,hadLocal:hadLocal,localCount:hadLocal?_jbCache.items.length:0});if(!hadLocal){if(d)_jbCache=normJb(d);else if(!_jbCache)_jbCache=defaultJb();}jbReady();});' +
    'wsGet(JA_SK,function(e,d){_jaCache=normJa(d||defaultJa());jbReady();});' +
    '})();<' +
    '/script>'
  );
}

function buildJobBoardHtml(deps) {
  const { getTlListStyles } = deps;
  const script = buildJobBoardClientScript();

  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Job board</h1>' +
    '<p class="sub">Track applications, links, dates, IDs, and notes—saved in MongoDB.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/todolist">Todo list</a>' +
    '<a class="link-pill" href="/data-analytics/job-board/closed-assessing">Closed · assessing</a>' +
    '<a class="link-pill" href="/data-analytics/job-board/accounts">Job accounts</a>' +
    '<a class="link-pill" href="/data-analytics/job-board/resumes">Resume library</a>' +
    '<a class="link-pill" href="/data-analytics/high-yield-activity">High yield activity</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tl-panel tl-job-board">' +
    getTlListStyles() +
    getTlJobBoardExtraStyles() +
    '<div class="tl-dayhead">' +
    '<div><h2 id="jb-label">Job board</h2><p>Log each role with application dates, IDs, and notes. Saved in MongoDB.</p></div>' +
    '</div>' +
    '<p class="tl-hint">After you add a Job ID, set Unapplied, Applied, or Assessing (for closed postings you are still waiting on). When Applied or Assessing, attach a portal account from Job accounts.</p>' +
    '<div class="jb-stats" aria-label="Job board summary">' +
    '<div class="jb-stat-card is-applied"><div class="jb-stat-value" id="jb-stat-applied">0</div><div class="jb-stat-label">Applied</div></div>' +
    '<div class="jb-stat-card is-closed"><div class="jb-stat-value" id="jb-stat-closed">0</div><div class="jb-stat-label">Closed</div></div>' +
    '<div class="jb-stat-card is-unapplied"><div class="jb-stat-value" id="jb-stat-unapplied">0</div><div class="jb-stat-label">Not applied</div></div>' +
    '</div>' +
    '<div class="tl-add">' +
    '<div class="tl-field"><label for="jb-job-name">Job name</label><input type="text" id="jb-job-name" class="jb-inp" autocomplete="off" placeholder="e.g. Data Analyst" /></div>' +
    '<div class="tl-field"><label for="jb-link">Link</label><input type="url" id="jb-link" class="jb-inp" autocomplete="off" placeholder="https://…" /></div>' +
    '<div class="tl-field"><label for="jb-applied">Date applied</label><input type="date" id="jb-applied" class="jb-inp" /></div>' +
    '<div class="tl-field"><label for="jb-closing">Closing date</label><input type="date" id="jb-closing" class="jb-inp" /></div>' +
    '<div class="tl-field"><label for="jb-rate">Rate</label><input type="text" id="jb-rate" class="jb-inp" autocomplete="off" placeholder="Salary or score" /></div>' +
    '<div class="tl-field"><label for="jb-add-resume">Resume</label><select id="jb-add-resume" class="jb-inp jb-resume-select"><option value="">Attach resume…</option></select></div>' +
    '<div class="tl-field"><label for="jb-job-id">Job ID</label><input type="text" id="jb-job-id" class="jb-inp" autocomplete="off" placeholder="Posting or ref ID" /></div>' +
    '<div class="tl-field"><label>&nbsp;</label><button type="button" id="jb-add-btn" class="tl-btn-add">+ Add</button></div>' +
    '</div>' +
    '<div class="tl-table-wrap">' +
    '<table class="tl-table" aria-label="Job applications">' +
    '<thead><tr><th>Job</th><th>Link</th><th>Applied</th><th>Closing</th><th>Rate</th><th>Resume</th><th>Job ID</th><th>Status</th><th>Account</th><th></th></tr></thead>' +
    '<tbody id="jb-tbody"></tbody>' +
    '</table>' +
    '<p id="jb-empty" class="tl-empty" hidden>No jobs yet.</p>' +
    '</div>' +
    script +
    '</div></div>'
  );
}

function buildJobBoardClosedAssessingHtml(deps) {
  const { getTlListStyles } = deps;
  const script = buildJobBoardClientScript({ mode: 'closed-assessing' });

  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Closed — under assessment</h1>' +
    '<p class="sub">Postings past their closing date that you are still assessing—how long since each closed.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/data-analytics/job-board">← Job board</a>' +
    '<a class="link-pill" href="/data-analytics/job-board/accounts">Job accounts</a>' +
    '<a class="link-pill" href="/data-analytics/job-board/resumes">Resume library</a>' +
    '<a class="link-pill" href="/">Home</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tl-panel tl-job-board">' +
    getTlListStyles() +
    getTlJobBoardExtraStyles() +
    '<div class="tl-dayhead">' +
    '<div><h2 id="jb-label">Closed — under assessment</h2><p>Closing date in the past and status <strong>Assessing</strong>, sorted by closing date (most recent close first).</p></div>' +
    '</div>' +
    '<p class="tl-hint">Use the yellow banner on the <a href="/data-analytics/job-board">job board</a> to jump here. Assessing jobs still open (before closing) stay on the main board with a days-left countdown.</p>' +
    '<div class="tl-table-wrap">' +
    '<table class="tl-table" aria-label="Closed jobs under assessment">' +
    '<thead><tr><th>Job</th><th>Link</th><th>Applied</th><th>Closing</th><th>Rate</th><th>Resume</th><th>Job ID</th><th>Status</th><th>Account</th><th></th></tr></thead>' +
    '<tbody id="jb-tbody"></tbody>' +
    '</table>' +
    '<p id="jb-empty" class="tl-empty" hidden>No closed jobs under assessment yet.</p>' +
    '</div>' +
    script +
    '</div></div>'
  );
}

const JOB_ACCOUNTS_STORAGE_KEY = 'secondBrainDataAnalyticsJobAccountsV1';

function getTlJobAccountsExtraStyles() {
  return (
    '<style>' +
    '.tl-job-accounts .tl-add{margin:0 0 18px;}' +
    '@media(min-width:900px){.tl-job-accounts .tl-add{grid-template-columns:repeat(3,minmax(0,1fr)) auto;}}' +
    '@media(min-width:720px) and (max-width:899px){.tl-job-accounts .tl-add{grid-template-columns:repeat(2,minmax(0,1fr));}}' +
    '.tl-job-accounts .tl-table{min-width:720px;}' +
    '.tl-job-accounts .tl-table th:nth-child(5){width:8.5rem;text-align:right;}' +
    '.tl-job-accounts .ja-inp{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:12px;}' +
    '.tl-job-accounts .ja-inp:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 2px rgba(13,148,136,0.12);}' +
    '.tl-job-accounts .ja-site-sub{display:block;font-size:11px;color:#64748b;margin-top:4px;}' +
    '.tl-job-accounts .ja-site-sub a{color:#0f766e;font-weight:600;text-decoration:none;}' +
    '.tl-job-accounts .ja-site-sub a:hover{text-decoration:underline;}' +
    '.tl-job-accounts .ja-pw-cell{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}' +
    '.tl-job-accounts .ja-pw-val{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#334155;word-break:break-all;}' +
    '.tl-job-accounts .ja-pw-mask{color:#94a3b8;letter-spacing:0.08em;}' +
    '.tl-job-accounts .jb-meta{font-size:11px;color:#64748b;}' +
    '.tl-job-accounts tr.tl-row-flagged td{background:#fffbeb;}' +
    '.tl-icon-btn.ja-pw-reveal:hover{background:#f5f3ff;border-color:#ddd6fe;color:#6d28d9;}' +
    '</style>'
  );
}

function buildJobAccountsClientScript() {
  return (
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var _jaCache=null;' +
    'var JA_SK=' +
    JSON.stringify(JOB_ACCOUNTS_STORAGE_KEY) +
    ';' +
    'var SVG_PENCIL=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>\';' +
    'var SVG_TRASH=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>\';' +
    'var SVG_FLAG=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 22V4"/><path d="M4 4h11l-2 4 2 4H4"/></svg>\';' +
    'var SVG_NOTE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>\';' +
    'var SVG_CHECK=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>\';' +
    'var SVG_X=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>\';' +
    'var SVG_EYE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>\';' +
    'function makeIconBtn(cls,label,svg){var b=document.createElement("button");b.type="button";b.className="tl-icon-btn "+cls;b.setAttribute("aria-label",label);b.innerHTML=svg;return b;}' +
    'var editingId=null;var revealIds={};' +
    'var tbody=document.getElementById("ja-tbody");var emptyEl=document.getElementById("ja-empty");var labelEl=document.getElementById("ja-label");var addBtn=document.getElementById("ja-add-btn");' +
    'var fSite=document.getElementById("ja-site-name");var fUrl=document.getElementById("ja-portal-url");var fUser=document.getElementById("ja-username");var fEmail=document.getElementById("ja-email");var fPass=document.getElementById("ja-password");' +
    'if(!tbody)return;' +
    'function nextId(){return"ja"+Date.now()+Math.random().toString(36).slice(2,9);}' +
    'function normAcct(a){if(!a||typeof a!=="object")return a;a.siteName=String(a.siteName||"");a.portalUrl=String(a.portalUrl||"");a.username=String(a.username||"");a.email=String(a.email||"");a.password=String(a.password||"");a.notes=String(a.notes||"");a.notesOpen=!!a.notesOpen;a.flagged=!!a.flagged;return a;}' +
    'function defaultJa(){return{version:1,items:[]};}' +
    'function normJaStore(o){if(!o||typeof o!=="object"||!Array.isArray(o.items))return defaultJa();o.items=o.items.map(normAcct);return o;}' +
    'function readStore(){if(_jaCache)return _jaCache;return defaultJa();}' +
    'function writeStore(o){_jaCache=normJaStore(o);wsPut(JA_SK,_jaCache);}' +
    'function findItem(o,id){for(var i=0;i<o.items.length;i++){if(String(o.items[i].id)===String(id))return o.items[i];}return null;}' +
    'function updateItem(id,patch){var o=readStore();var it=findItem(o,id);if(it)Object.assign(it,patch);writeStore(o);render();}' +
    'function removeItem(id){var o=readStore();o.items=o.items.filter(function(it){return String(it.id)!==String(id);});delete revealIds[id];writeStore(o);render();}' +
    'function mkInp(val,ph,type){var inp=document.createElement("input");inp.type=type||"text";inp.className="ja-inp";inp.value=String(val||"");if(ph)inp.placeholder=ph;return inp;}' +
    'function readRowFields(tr){return{siteName:(tr.querySelector(".ja-site-name")||{}).value||"",portalUrl:(tr.querySelector(".ja-portal-url")||{}).value||"",username:(tr.querySelector(".ja-username")||{}).value||"",email:(tr.querySelector(".ja-email")||{}).value||"",password:(tr.querySelector(".ja-password")||{}).value||""};}' +
    'function clearAddForm(){if(fSite)fSite.value="";if(fUrl)fUrl.value="";if(fUser)fUser.value="";if(fEmail)fEmail.value="";if(fPass)fPass.value="";}' +
    'function addItem(){var siteName=fSite?String(fSite.value||"").trim():"";if(!siteName){if(fSite)fSite.focus();return;}var o=readStore();o.items.push(normAcct({id:nextId(),siteName:siteName,portalUrl:fUrl?String(fUrl.value||"").trim():"",username:fUser?String(fUser.value||"").trim():"",email:fEmail?String(fEmail.value||"").trim():"",password:fPass?String(fPass.value||""):"",notes:"",notesOpen:false,flagged:false}));writeStore(o);clearAddForm();render();if(fSite)fSite.focus();}' +
    'function appendPwCell(td,it){var wrap=document.createElement("div");wrap.className="ja-pw-cell";var pw=String(it.password||"");if(!pw){wrap.innerHTML=\'<span class="jb-meta">—</span>\';td.appendChild(wrap);return;}var shown=!!revealIds[it.id];var span=document.createElement("span");span.className=shown?"ja-pw-val":"ja-pw-mask";span.textContent=shown?pw:"••••••••";wrap.appendChild(span);var btn=makeIconBtn("ja-pw-reveal",shown?"Hide password":"Show password",SVG_EYE);btn.setAttribute("data-id",it.id);if(shown)btn.classList.add("is-active");wrap.appendChild(btn);td.appendChild(wrap);}' +
    'function appendRow(it,isEdit){var tr=document.createElement("tr");tr.setAttribute("data-id",it.id);if(it.flagged)tr.classList.add("tl-row-flagged");var tdSite=document.createElement("td");var tdUser=document.createElement("td");var tdEmail=document.createElement("td");var tdPw=document.createElement("td");if(isEdit){var iSite=mkInp(it.siteName,"e.g. City of Toronto");iSite.className+=" ja-site-name";tdSite.appendChild(iSite);var iUrl=mkInp(it.portalUrl,"https://…");iUrl.className+=" ja-portal-url";tdSite.appendChild(iUrl);var iUser=mkInp(it.username,"Username");iUser.className+=" ja-username";tdUser.appendChild(iUser);var iEmail=mkInp(it.email,"email@example.com");iEmail.type="email";iEmail.className+=" ja-email";tdEmail.appendChild(iEmail);var iPw=mkInp(it.password,"Password");iPw.type="password";iPw.className+=" ja-password";iPw.autocomplete="off";tdPw.appendChild(iPw);}else{var t=document.createElement("span");t.className="tl-view-text";t.textContent=String(it.siteName||"").trim()||"Untitled";tdSite.appendChild(t);var url=String(it.portalUrl||"").trim();if(url){var sub=document.createElement("span");sub.className="ja-site-sub";var a=document.createElement("a");a.href=url;a.target="_blank";a.rel="noopener noreferrer";a.textContent=url.length>48?url.slice(0,48)+"…":url;sub.appendChild(a);tdSite.appendChild(sub);}tdUser.innerHTML=\'<span class="jb-meta">\'+(String(it.username||"").trim()||"—")+"</span>";tdEmail.innerHTML=\'<span class="jb-meta">\'+(String(it.email||"").trim()||"—")+"</span>";appendPwCell(tdPw,it);}var tdAct=document.createElement("td");tdAct.className="tl-td-actions";var actWrap=document.createElement("div");actWrap.className="tl-actions";if(isEdit){actWrap.appendChild(makeIconBtn("tl-save","Save account",SVG_CHECK));actWrap.appendChild(makeIconBtn("tl-cancel","Cancel editing",SVG_X));}else{var btnNotes=makeIconBtn("tl-notes-btn","Notes",SVG_NOTE);if(it.notesOpen)btnNotes.classList.add("is-open");if(String(it.notes||"").trim())btnNotes.classList.add("has-content");actWrap.appendChild(btnNotes);var btnFlag=makeIconBtn("tl-flag","Toggle flag",SVG_FLAG);if(it.flagged)btnFlag.classList.add("is-active");actWrap.appendChild(btnFlag);actWrap.appendChild(makeIconBtn("tl-edit","Edit account",SVG_PENCIL));actWrap.appendChild(makeIconBtn("tl-remove","Delete account",SVG_TRASH));}tdAct.appendChild(actWrap);tr.appendChild(tdSite);tr.appendChild(tdUser);tr.appendChild(tdEmail);tr.appendChild(tdPw);tr.appendChild(tdAct);tbody.appendChild(tr);var trN=document.createElement("tr");trN.className="tl-row-notes";trN.setAttribute("data-for",it.id);if(!it.notesOpen)trN.hidden=true;var tdN=document.createElement("td");tdN.colSpan=5;var panel=document.createElement("div");panel.className="tl-task-notes-panel";var ta=document.createElement("textarea");ta.className="tl-notes-field tl-task-notes";ta.setAttribute("data-id",it.id);ta.value=String(it.notes||"");ta.placeholder="Security questions, 2FA backup codes, extra login details…";ta.spellcheck=true;panel.appendChild(ta);tdN.appendChild(panel);trN.appendChild(tdN);tbody.appendChild(trN);if(isEdit){var focusEl=tr.querySelector(".ja-site-name");if(focusEl)focusEl.focus();}}' +
    'function render(){var o=readStore();if(editingId&&!findItem(o,editingId))editingId=null;tbody.innerHTML="";var flagged=0;o.items.forEach(function(it){if(it.flagged)flagged++;});if(labelEl)labelEl.textContent=o.items.length?o.items.length+" account"+(o.items.length===1?"":"s")+(flagged?" · "+flagged+" flagged":""):"Job accounts";o.items.forEach(function(it){appendRow(it,editingId===it.id);});if(emptyEl)emptyEl.hidden=o.items.length>0;}' +
    'function saveEditingRow(tr){if(!tr)return;var id=tr.getAttribute("data-id");var f=readRowFields(tr);var siteName=String(f.siteName||"").trim();if(!siteName){var el=tr.querySelector(".ja-site-name");if(el)el.focus();return;}editingId=null;updateItem(id,{siteName:siteName,portalUrl:String(f.portalUrl||"").trim(),username:String(f.username||"").trim(),email:String(f.email||"").trim(),password:String(f.password||"")});}' +
    'if(addBtn)addBtn.addEventListener("click",addItem);' +
    'if(fSite)fSite.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();addItem();}});' +
    'tbody.addEventListener("input",function(e){var ta=e.target.closest("textarea.tl-task-notes");if(!ta)return;var id=ta.getAttribute("data-id");if(!id)return;var o=readStore();var it=findItem(o,id);if(!it)return;it.notes=ta.value;writeStore(o);});' +
    'tbody.addEventListener("keydown",function(e){var tr=e.target.closest("tr[data-id]");if(!tr||editingId!==tr.getAttribute("data-id"))return;if(e.key==="Enter"&&e.target.classList.contains("ja-site-name")){e.preventDefault();saveEditingRow(tr);}else if(e.key==="Escape"){e.preventDefault();editingId=null;render();}});' +
    'tbody.addEventListener("click",function(e){var tr=e.target.closest("tr[data-id]");if(!tr)return;var id=tr.getAttribute("data-id");if(e.target.closest(".ja-pw-reveal")){revealIds[id]=!revealIds[id];render();return;}if(e.target.closest(".tl-notes-btn")){var o=readStore();var it=findItem(o,id);if(it)updateItem(id,{notesOpen:!it.notesOpen});return;}if(e.target.closest(".tl-flag")){var o2=readStore();var it2=findItem(o2,id);if(it2)updateItem(id,{flagged:!it2.flagged});return;}if(e.target.closest(".tl-edit")){editingId=id;render();return;}if(e.target.closest(".tl-save")){saveEditingRow(tr);return;}if(e.target.closest(".tl-cancel")){editingId=null;render();return;}if(e.target.closest(".tl-remove")){if(editingId===id)editingId=null;removeItem(id);}});' +
    'wsGet(JA_SK,function(err,d){_jaCache=normJaStore(d||defaultJa());if(!d)writeStore(_jaCache);render();});' +
    '})();<' +
    '/script>'
  );
}

function buildJobAccountsHtml(deps) {
  const { getTlListStyles } = deps;
  const script = buildJobAccountsClientScript();

  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Job accounts</h1>' +
    '<p class="sub">Save login details for job portals (e.g. City of Toronto)—stored only in this browser.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/data-analytics/job-board">Job board</a>' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/todolist">Todo list</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tl-panel tl-job-accounts">' +
    getTlListStyles() +
    getTlJobAccountsExtraStyles() +
    '<div class="tl-dayhead">' +
    '<div><h2 id="ja-label">Job accounts</h2><p>Portal name, username, email, and password for each site you apply on.</p></div>' +
    '</div>' +
    '<p class="tl-hint">Passwords stay in local storage on this device only—not encrypted. Use notes for 2FA or security questions.</p>' +
    '<div class="tl-add">' +
    '<div class="tl-field"><label for="ja-site-name">Site / employer</label><input type="text" id="ja-site-name" class="ja-inp" autocomplete="off" placeholder="e.g. City of Toronto" /></div>' +
    '<div class="tl-field"><label for="ja-portal-url">Portal URL</label><input type="url" id="ja-portal-url" class="ja-inp" autocomplete="off" placeholder="https://…" /></div>' +
    '<div class="tl-field"><label for="ja-username">Username</label><input type="text" id="ja-username" class="ja-inp" autocomplete="username" placeholder="Username" /></div>' +
    '<div class="tl-field"><label for="ja-email">Email</label><input type="email" id="ja-email" class="ja-inp" autocomplete="email" placeholder="you@example.com" /></div>' +
    '<div class="tl-field"><label for="ja-password">Password</label><input type="password" id="ja-password" class="ja-inp" autocomplete="new-password" placeholder="Password" /></div>' +
    '<div class="tl-field"><label>&nbsp;</label><button type="button" id="ja-add-btn" class="tl-btn-add">+ Add</button></div>' +
    '</div>' +
    '<div class="tl-table-wrap">' +
    '<table class="tl-table" aria-label="Job portal accounts">' +
    '<thead><tr><th>Site</th><th>Username</th><th>Email</th><th>Password</th><th></th></tr></thead>' +
    '<tbody id="ja-tbody"></tbody>' +
    '</table>' +
    '<p id="ja-empty" class="tl-empty" hidden>No accounts yet.</p>' +
    '</div>' +
    script +
    '</div></div>'
  );
}

function getTlLearningTopicNotesStyles() {
  return (
    '<style>' +
    '.tl-topic-notes-page{max-width:52rem;margin:0 auto;}' +
    '.tl-topic-notes-head{margin:0 0 16px;}' +
    '.tl-topic-notes-head h2{margin:0 0 6px;font-size:1.35rem;font-weight:800;color:#0f172a;}' +
    '.tl-topic-notes-head p{margin:0;font-size:13px;color:#64748b;}' +
    '.tl-topic-notes-meta{margin:0 0 14px;font-size:12px;color:#64748b;}' +
    '.tl-topic-notes-meta strong{color:#0f766e;}' +
    '.tl-long-notes-field{width:100%;min-height:min(62vh,560px);box-sizing:border-box;padding:14px 16px;border:1px solid #e2e8f0;border-radius:12px;font:inherit;font-size:14px;line-height:1.6;color:#0f172a;background:#fff;resize:vertical;}' +
    '.tl-long-notes-field:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,0.15);}' +
    '.tl-topic-notes-foot{margin:10px 0 0;font-size:12px;color:#94a3b8;}' +
    '.tl-topic-notes-foot.is-saved{color:#0f766e;}' +
    '</style>'
  );
}

function buildLearningTopicNotesClientScript(storageKey, taskId) {
  return (
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var _learnCache=null;' +
    'var SK=' +
    JSON.stringify(storageKey) +
    ';' +
    'var TASK_ID=' +
    JSON.stringify(String(taskId || '')) +
    ';' +
    'var titleEl=document.getElementById("tl-topic-title");' +
    'var sectionEl=document.getElementById("tl-topic-section");' +
    'var field=document.getElementById("tl-long-notes-field");' +
    'var footEl=document.getElementById("tl-topic-notes-foot");' +
    'var saveTimer=null;' +
    'function normTask(t){if(!t||typeof t!=="object")return t;if(typeof t.notes!=="string")t.notes="";if(typeof t.longNotes!=="string")t.longNotes="";if(typeof t.notesOpen!=="boolean")t.notesOpen=false;if(typeof t.time!=="string")t.time="";if(typeof t.progress!=="number"||isNaN(t.progress))t.progress=0;return t;}' +
    'function readStore(){return _learnCache;}' +
    'function writeStore(o){_learnCache=o;wsPut(SK,o);}' +
    'function findTaskLoc(o,id){for(var i=0;i<o.sections.length;i++){for(var j=0;j<o.sections[i].tasks.length;j++){if(String(o.sections[i].tasks[j].id)===String(id))return{section:o.sections[i],task:o.sections[i].tasks[j]};}}return null;}' +
    'function setSaved(){if(footEl){footEl.textContent="Saved";footEl.classList.add("is-saved");setTimeout(function(){if(footEl){footEl.textContent="Changes save automatically";footEl.classList.remove("is-saved");}},1400);}}' +
    'function saveLongNotes(val){var o=readStore();if(!o)return;var loc=findTaskLoc(o,TASK_ID);if(!loc)return;loc.task.longNotes=String(val!=null?val:"");writeStore(o);setSaved();}' +
    'function scheduleSave(){if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(function(){saveTimer=null;if(field)saveLongNotes(field.value);},400);}' +
    'function load(){var o=readStore();var loc=o?findTaskLoc(o,TASK_ID):null;if(!loc){if(titleEl)titleEl.textContent="Topic not found";if(sectionEl)sectionEl.textContent="This topic is missing from your learning track.";if(field){field.disabled=true;field.placeholder="Go back to the learning track.";}return;}if(titleEl)titleEl.textContent=String(loc.task.text||"Topic");if(sectionEl)sectionEl.innerHTML="Section: <strong>"+String(loc.section.title||"").replace(/</g,"&lt;")+"</strong>";if(field)field.value=String(loc.task.longNotes||"");}' +
    'if(field){field.addEventListener("input",scheduleSave);field.addEventListener("blur",function(){if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}saveLongNotes(field.value);});}' +
    'wsGet(SK,function(err,d){if(d&&Array.isArray(d.sections)){d.sections.forEach(function(sec){if(!Array.isArray(sec.tasks))sec.tasks=[];sec.tasks=sec.tasks.map(normTask);});_learnCache=d;}load();});' +
    '})();<' +
    '/script>'
  );
}

function buildLearningTopicNotesHtml(deps) {
  const { taskId, getTlListStyles, escAttr, escHtml, dataAnalyticsSubNavHtml } = deps;
  const subNav = dataAnalyticsSubNavHtml
    ? dataAnalyticsSubNavHtml('/data-analytics/learning/topic/' + String(taskId || ''))
    : '';
  const script = buildLearningTopicNotesClientScript(LEARNING_STORAGE_KEY, taskId);
  const backHref = '/data-analytics/learning';

  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Data analytics</h1>' +
    '<p class="sub">Long notes for a learning topic.</p>' +
    subNav +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="' +
    escAttr(backHref) +
    '">Back to learning track</a>' +
    '<a class="link-pill" href="/">Home</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tl-panel tl-topic-notes-page">' +
    getTlListStyles() +
    getTlLearningTopicNotesStyles() +
    '<div class="tl-topic-notes-head">' +
    '<h2 id="tl-topic-title">Loading topic…</h2>' +
    '<p id="tl-topic-section">Loading section…</p>' +
    '</div>' +
    '<textarea id="tl-long-notes-field" class="tl-long-notes-field" spellcheck="true" autocomplete="off" placeholder="Write longer notes, summaries, links, or study material for this topic…"></textarea>' +
    '<p id="tl-topic-notes-foot" class="tl-topic-notes-foot">Changes save automatically</p>' +
    script +
    '</div></div>'
  );
}

module.exports = {
  LEARNING_STORAGE_KEY,
  LEARNING_SEED_SECTIONS,
  OVERVIEW_STORAGE_KEY,
  MEDICAL_PHYSICS_OVERVIEW_STORAGE_KEY,
  buildLearningWorkspaceHtml,
  buildLearningTopicNotesHtml,
  buildCareerOverviewHtml,
  buildDataAnalyticsOverviewHtml,
  buildStudyingMedicalPhysicsOverviewHtml,
  buildHighYieldActivityHtml,
  buildJobBoardHtml,
  buildJobBoardClosedAssessingHtml,
  buildJobAccountsHtml,
  HIGH_YIELD_STORAGE_KEY,
  JOB_BOARD_STORAGE_KEY,
  JOB_ACCOUNTS_STORAGE_KEY
};
