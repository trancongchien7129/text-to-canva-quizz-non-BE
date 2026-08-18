/* ==========================================================
   QuizStudy — 100% frontend quiz app
   No backend, no database, no API key.
   ========================================================== */

// ----- Global state -----
let questions = [];        // [{id, question, options:{A,B,C,D}}]
let userAnswers = {};       // { questionId: "A" }
let currentIndex = 0;

// ----- DOM refs -----
const screenUpload = document.getElementById('screen-upload');
const screenQuiz = document.getElementById('screen-quiz');
const screenDone = document.getElementById('screen-done');

const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
const uploadStatus = document.getElementById('uploadStatus');
const btnStartQuiz = document.getElementById('btnStartQuiz');

const progressText = document.getElementById('progressText');
const progressBarFill = document.getElementById('progressBarFill');
const questionNumber = document.getElementById('questionNumber');
const questionText = document.getElementById('questionText');
const optionsList = document.getElementById('optionsList');
const quizJump = document.getElementById('quizJump');

const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnSubmit = document.getElementById('btnSubmit');
const submitHint = document.getElementById('submitHint');
const btnRestart = document.getElementById('btnRestart');

const toast = document.getElementById('toast');

// Configure pdf.js worker (CDN)
if (window['pdfjsLib']) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ==========================================================
   1) FILE READING — returns plain text from PDF/DOCX/TXT/Image
   ========================================================== */

async function readFileAsText(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'txt') {
    return await readTxtFile(file);
  }
  if (ext === 'pdf') {
    return await readPdfFile(file);
  }
  if (ext === 'docx') {
    return await readDocxFile(file);
  }
  if (['jpg', 'jpeg', 'png'].includes(ext)) {
    return await readImageFileWithOCR(file);
  }
  throw new Error('Định dạng file không được hỗ trợ: .' + ext);
}

function readTxtFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Không đọc được file TXT.'));
    reader.readAsText(file, 'utf-8');
  });
}

async function readPdfFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    fullText += pageText + '\n';
  }
  return fullText;
}

async function readDocxFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function readImageFileWithOCR(file) {
  updateStatus('Đang nhận diện chữ trong ảnh (OCR)... có thể mất chút thời gian.', 'info');
  const { data } = await Tesseract.recognize(file, 'eng+vie');
  return data.text;
}

/* ==========================================================
   2) PARSING — text -> array of question objects
   Expected pattern:
   Question 1: ...
   A. ...
   B. ...
   C. ...
   D. ...
   (also tolerates "Câu 1", "1.", no colon, etc.)
   ========================================================== */

function parseQuestions(rawText) {
  // Normalize line breaks and strip weird whitespace
  const text = rawText.replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Regex to detect a new question line:
  // "Question 1:", "Question 1.", "Câu 1:", "Câu 1.", "1)", "1."
  const questionStartRe = /^(?:question|câu|cau)\s*(\d+)\s*[:.\)]?\s*(.*)$/i;
  const looseNumberRe = /^(\d+)\s*[.\)]\s*(.*)$/;

  // Regex to detect an option line: "A. text", "A) text", "A: text"
  const optionRe = /^([A-Da-d])\s*[.:\)]\s*(.+)$/;

  const parsed = [];
  let current = null;

  for (const line of lines) {
    const qMatch = line.match(questionStartRe) || line.match(looseNumberRe);
    const optMatch = line.match(optionRe);

    if (qMatch && !optMatch) {
      // Push previous question if valid
      if (current) parsed.push(current);
      current = {
        id: parsed.length + 1,
        question: qMatch[2] ? qMatch[2].trim() : '',
        options: {}
      };
      continue;
    }

    if (optMatch && current) {
      const letter = optMatch[1].toUpperCase();
      const text = optMatch[2].trim();
      current.options[letter] = text;
      continue;
    }

    // Otherwise: continuation of question text (multi-line question)
    if (current && Object.keys(current.options).length === 0) {
      current.question = (current.question + ' ' + line).trim();
    }
  }
  if (current) parsed.push(current);

  // Keep only questions that have at least 2 options and non-empty question text
  const valid = parsed.filter(q =>
    q.question && Object.keys(q.options).length >= 2
  );

  // Re-number sequentially in case some were dropped
  valid.forEach((q, idx) => { q.id = idx + 1; });

  return valid;
}

/* ==========================================================
   3) RENDER UI
   ========================================================== */

function renderQuestion(index) {
  const q = questions[index];
  questionNumber.textContent = `Câu ${q.id}`;
  questionText.textContent = q.question;

  optionsList.innerHTML = '';
  const letters = Object.keys(q.options).sort();

  letters.forEach(letter => {
    const item = document.createElement('div');
    item.className = 'option-item';
    if (userAnswers[q.id] === letter) item.classList.add('selected');

    item.innerHTML = `
      <div class="option-letter">${letter}</div>
      <div class="option-text">${escapeHtml(q.options[letter])}</div>
    `;
    item.addEventListener('click', () => selectAnswer(q.id, letter));
    optionsList.appendChild(item);
  });

  updateProgress();
  renderJumpDots();
  updateNavButtons();
}

function selectAnswer(questionId, letter) {
  userAnswers[questionId] = letter;
  renderQuestion(currentIndex);
  updateSubmitState();
}

function updateProgress() {
  const total = questions.length;
  const current = currentIndex + 1;
  progressText.textContent = `Câu ${current} / ${total}`;
  progressBarFill.style.width = `${(current / total) * 100}%`;
}

function renderJumpDots() {
  quizJump.innerHTML = '';
  questions.forEach((q, idx) => {
    const dot = document.createElement('div');
    dot.className = 'jump-dot';
    if (userAnswers[q.id]) dot.classList.add('answered');
    if (idx === currentIndex) dot.classList.add('current');
    dot.title = `Câu ${q.id}`;
    dot.addEventListener('click', () => {
      currentIndex = idx;
      renderQuestion(currentIndex);
    });
    quizJump.appendChild(dot);
  });
}

function updateNavButtons() {
  btnPrev.disabled = currentIndex === 0;
  btnNext.disabled = currentIndex === questions.length - 1;
}

function updateSubmitState() {
  const allAnswered = questions.every(q => userAnswers[q.id]);
  btnSubmit.disabled = !allAnswered;
  submitHint.textContent = allAnswered
    ? 'Bạn đã trả lời tất cả câu hỏi. Sẵn sàng nộp bài!'
    : `Hoàn thành tất cả câu hỏi để nộp bài (${Object.keys(userAnswers).length}/${questions.length})`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ==========================================================
   4) GENERATE ANSWER FILE
   ========================================================== */

function generateAnswerFile() {
  let content = 'ĐÁP ÁN\n';
  questions.forEach(q => {
    content += `Câu ${q.id}: ${userAnswers[q.id]}\n`;
  });

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dap_an.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ==========================================================
   5) UI helpers (status / toast)
   ========================================================== */

function updateStatus(message, type) {
  uploadStatus.textContent = message;
  uploadStatus.classList.remove('hidden', 'error', 'success');
  if (type === 'error') uploadStatus.classList.add('error');
  if (type === 'success') uploadStatus.classList.add('success');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3500);
}

function showScreen(screen) {
  [screenUpload, screenQuiz, screenDone].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

/* ==========================================================
   6) EVENT WIRING
   ========================================================== */

let lastParsedQuestions = null; // holds result until user confirms "Bắt đầu làm bài"

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    handleFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

async function handleFile(file) {
  btnStartQuiz.classList.add('hidden');
  lastParsedQuestions = null;
  updateStatus(`Đang đọc file "${file.name}"...`, 'info');

  try {
    const text = await readFileAsText(file);

    if (!text || !text.trim()) {
      throw new Error('Không trích xuất được nội dung nào từ file. Vui lòng thử file khác.');
    }

    const parsed = parseQuestions(text);

    if (parsed.length === 0) {
      throw new Error(
        'Không nhận diện được câu hỏi trắc nghiệm nào trong file. ' +
        'Hãy chắc chắn file có định dạng: "Question 1: ..." kèm các đáp án "A. ...", "B. ...".'
      );
    }

    lastParsedQuestions = parsed;
    updateStatus(`✅ Đã nhận diện ${parsed.length} câu hỏi từ file.`, 'success');
    btnStartQuiz.classList.remove('hidden');

  } catch (err) {
    console.error(err);
    updateStatus('❌ ' + err.message, 'error');
    showToast(err.message);
  }
}

btnStartQuiz.addEventListener('click', () => {
  if (!lastParsedQuestions) return;
  questions = lastParsedQuestions;
  userAnswers = {};
  currentIndex = 0;
  showScreen(screenQuiz);
  renderQuestion(currentIndex);
  updateSubmitState();
});

btnPrev.addEventListener('click', () => {
  if (currentIndex > 0) {
    currentIndex--;
    renderQuestion(currentIndex);
  }
});

btnNext.addEventListener('click', () => {
  if (currentIndex < questions.length - 1) {
    currentIndex++;
    renderQuestion(currentIndex);
  }
});

btnSubmit.addEventListener('click', () => {
  const allAnswered = questions.every(q => userAnswers[q.id]);
  if (!allAnswered) return;
  generateAnswerFile();
  showScreen(screenDone);
});

btnRestart.addEventListener('click', () => {
  questions = [];
  userAnswers = {};
  currentIndex = 0;
  lastParsedQuestions = null;
  fileInput.value = '';
  uploadStatus.classList.add('hidden');
  btnStartQuiz.classList.add('hidden');
  showScreen(screenUpload);
});
