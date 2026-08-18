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
const btnSubmitNow = document.getElementById('btnSubmitNow');
const submitHint = document.getElementById('submitHint');
const btnRestart = document.getElementById('btnRestart');

const toast = document.getElementById('toast');

async function ensureLibrary(globalName, srcList) {
  const sourceList = Array.isArray(srcList) ? srcList : [srcList];

  if (window[globalName]) return window[globalName];

  for (const src of sourceList) {
    try {
      await new Promise((resolve, reject) => {
        const exists = document.querySelector(`script[src="${src}"]`);
        if (exists) {
          if (window[globalName]) {
            resolve(window[globalName]);
            return;
          }
          exists.addEventListener('load', () => resolve(window[globalName]), { once: true });
          exists.addEventListener('error', () => reject(new Error(`Script ${src} lỗi.`)), { once: true });
          return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => {
          if (window[globalName]) resolve(window[globalName]);
          else reject(new Error(`Thư viện ${globalName} không khởi tạo được.`));
        };
        script.onerror = () => reject(new Error(`Không tải được ${src}.`));
        document.head.appendChild(script);
      });

      if (window[globalName]) return window[globalName];
    } catch (err) {
      // Try next CDN if current one fails
      if (sourceList.indexOf(src) === sourceList.length - 1) throw err;
    }
  }

  throw new Error(`Không tải được thư viện ${globalName}. Hãy kiểm tra mạng hoặc dùng file local.`);
}

async function ensurePdfJs() {
  const pdfLib = await ensureLibrary('pdfjsLib', [
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
  ]);

  if (pdfLib.GlobalWorkerOptions) {
    pdfLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  return pdfLib;
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
  try {
    const pdfLib = await ensurePdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      fullText += pageText + '\n';
    }
    return fullText;
  } catch (err) {
    throw new Error(err.message || 'Không đọc được file PDF.');
  }
}

async function readDocxFile(file) {
  if (!window.mammoth) {
    throw new Error('Thư viện DOCX chưa được nạp. Hãy kiểm tra file mammoth.browser.min.js trong project.');
  }

  const arrayBuffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function readImageFileWithOCR(file) {
  try {
    updateStatus('Đang nhận diện chữ trong ảnh (OCR)... có thể mất chút thời gian.', 'info');
    const tesseractLib = await ensureLibrary('Tesseract', [
      'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js'
    ]);
    const { data } = await (window.Tesseract || tesseractLib).recognize(file, 'eng+vie');
    return data.text;
  } catch (err) {
    throw new Error(err.message || 'OCR không hoạt động. Kiểm tra mạng hoặc thử lại.');
  }
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
  const text = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\*\*([A-D])\*\*/g, '$1.')
    .trim();

  if (!text) return [];

  const blocks = text.split(/(?=\s*(?:Câu|Cau|Question)\s*\d+\s*(?:[.:]|$))/i)
    .map(s => s.trim())
    .filter(Boolean);

  const questionBlocks = blocks.length ? blocks : [text];
  const parsed = [];

  function findAnswerMarker(body, letter, fromIndex = 0) {
    const regex = new RegExp(`(?<![A-Za-z])${letter}(?:\\*\\*)?\\s*(?:[.:)]|(?=\\s*(?:\\n|$)))`, 'gi');
    regex.lastIndex = fromIndex;

    let match = null;
    while ((match = regex.exec(body)) !== null) {
      const actualIndex = match.index + match[0].indexOf(letter);
      if (actualIndex >= fromIndex) {
        return {
          letter,
          start: actualIndex,
          end: match.index + match[0].length
        };
      }
    }

    return null;
  }

  for (const block of questionBlocks) {
    const blockText = block.replace(/\s+/g, ' ').trim();
    if (!blockText) continue;

    const qMatch = blockText.match(/^(?:Câu|Cau|Question)\s*(\d+)\s*[.:]?\s*([\s\S]*)$/i);
    const body = qMatch ? qMatch[2].trim() : blockText;
    if (!body) continue;

    const markers = [];
    let cursor = 0;

    for (const letter of ['A', 'B', 'C', 'D']) {
      const marker = findAnswerMarker(body, letter, cursor);
      if (!marker) break;
      markers.push(marker);
      cursor = marker.end;
    }

    if (markers.length < 4) continue;

    const options = {};
    for (let i = 0; i < markers.length; i++) {
      const current = markers[i];
      const next = markers[i + 1] || { start: body.length };
      const value = body.slice(current.end, next.start)
        .replace(/^[\s:.)]+|[\s:.)]+$/g, '')
        .trim();

      if (value) options[current.letter] = value;
    }

    const question = body.slice(0, markers[0].start).replace(/\s+/g, ' ').trim();

    if (question && Object.keys(options).length >= 4) {
      parsed.push({
        id: qMatch ? Number(qMatch[1]) : parsed.length + 1,
        question,
        options
      });
    }
  }

  return parsed;
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
  const currentQuestion = questions[currentIndex];
  const current = currentQuestion ? currentQuestion.id : 0;
  progressText.textContent = `Câu ${current} / ${total}`;
  progressBarFill.style.width = `${(currentIndex / Math.max(total - 1, 1)) * 100}%`;
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

    console.log('Số câu:', parsed.length);
    console.log('Các câu đã nhận:', parsed.map(q => q.id));

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

btnSubmitNow.addEventListener('click', () => {
  questions.forEach(q => {
    if (!userAnswers[q.id]) userAnswers[q.id] = '';
  });
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
