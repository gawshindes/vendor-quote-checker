'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('reviewForm');
  const fileInput = $('document');
  const drop = $('dropZone');
  const errorBox = $('formError');
  const submitBtn = $('submitBtn');
  const maxMb = Number((document.querySelector('.pick-row .hint').textContent.match(/(\d+) MB/) || [])[1] || 20);
  let file = null;

  const showError = (msg) => { errorBox.textContent = msg; errorBox.hidden = !msg; if (msg) errorBox.scrollIntoView({ block: 'nearest' }); };
  const sizeText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  function setFile(f) {
    showError('');
    if (!f) { file = null; fileInput.value = ''; $('fileRow').hidden = true; $('pickLabel').textContent = 'Choose a PDF'; return; }
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    if (!isPdf) { showError('That file is not a PDF. Choose a PDF, or save the document as a PDF first.'); return; }
    if (f.size > maxMb * 1048576) { showError(`That file is larger than ${maxMb} MB.`); return; }
    file = f;
    $('fileName').textContent = f.name;
    $('fileMeta').textContent = `${sizeText(f.size)} · ready to review`;
    $('fileRow').hidden = false;
    $('pickLabel').textContent = 'Choose a different PDF';
  }

  fileInput.addEventListener('change', () => setFile(fileInput.files && fileInput.files[0]));
  $('removeFile').addEventListener('click', () => setFile(null));
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => setFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));

  function validate() {
    const data = new FormData(form);
    if (!data.get('businessSize')) return 'Choose your business size.';
    if (!data.get('role')) return 'Choose your role.';
    if (!file) return 'Choose the vendor’s PDF.';
    const email = String(data.get('email') || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return 'Enter a valid email address.';
    if (data.get('acceptTerms') !== 'yes') return 'Please confirm that you understand the review is for information only.';
    return '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const problem = validate();
    if (problem) { showError(problem); return; }
    showError('');
    const data = new FormData(form);
    data.set('document', file, file.name);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Uploading...';
    try {
      const res = await fetch('/api/review', { method: 'POST', body: data });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || 'Something went wrong. Please try again.');
      $('sentFile').textContent = out.fileName;
      $('sentEmail').textContent = out.email;
      $('formView').hidden = true;
      $('sentView').hidden = false;
      $('sentView').focus();
      window.scrollTo(0, 0);
    } catch (err) {
      showError(err.message || 'The upload did not work. Check your connection and try again.');
      if (window.turnstile) try { window.turnstile.reset(); } catch { /* ignore */ }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Email me the review';
    }
  });

  function reset(keepEmail) {
    const email = form.email.value;
    form.reset();
    setFile(null);
    if (keepEmail) form.email.value = email;
    if (window.turnstile) try { window.turnstile.reset(); } catch { /* ignore */ }
    $('sentView').hidden = true;
    $('formView').hidden = false;
    window.scrollTo(0, 0);
  }
  $('startAgain').addEventListener('click', () => reset(false));
  $('another').addEventListener('click', () => reset(true));
})();
