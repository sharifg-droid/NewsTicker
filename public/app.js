(() => {
  const root = document.documentElement;
  const button = document.querySelector('[data-theme-toggle]');
  const stored = localStorage.getItem('sgnews-theme');
  const initial = stored || 'dark';
  root.dataset.theme = initial;

  if (button) {
    button.textContent = initial === 'dark' ? 'Light mode' : 'Dark mode';
    button.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      localStorage.setItem('sgnews-theme', next);
      button.textContent = next === 'dark' ? 'Light mode' : 'Dark mode';
    });
  }


  const cmsForm = document.querySelector('[data-cms-form]');
  const editor = document.querySelector('[data-editor]');
  const bodyField = document.querySelector('[data-body-html]');
  const toolbar = document.querySelector('[data-editor-toolbar]');
  const imageButton = document.querySelector('[data-image-button]');
  const imageInput = document.querySelector('[data-image-input]');

  if (cmsForm && editor && bodyField) {
    cmsForm.addEventListener('submit', () => {
      bodyField.value = editor.innerHTML;
    });
  }

  if (toolbar && editor) {
    toolbar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-cmd]');
      if (!button) return;
      event.preventDefault();
      editor.focus();
      const cmd = button.dataset.cmd;
      let value = button.dataset.value || null;
      if (cmd === 'createLink') {
        value = window.prompt('Link URL');
        if (!value) return;
      }
      document.execCommand(cmd, false, value);
    });
  }

  if (imageButton && imageInput && editor) {
    imageButton.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', async () => {
      const file = imageInput.files && imageInput.files[0];
      if (!file) return;
      imageButton.disabled = true;
      imageButton.textContent = 'Uploading…';
      try {
        const data = new FormData();
        data.append('image', file);
        const response = await fetch(editor.dataset.uploadUrl, {
          method: 'POST',
          body: data,
          credentials: 'same-origin'
        });
        const result = await response.json();
        if (!response.ok || !result.url) throw new Error(result.error || 'Upload failed');
        editor.focus();
        document.execCommand('insertHTML', false,
          '<figure><img src="' + result.url + '" alt=""><figcaption>Image caption</figcaption></figure><p><br></p>'
        );
      } catch (error) {
        window.alert(error.message || 'Image upload failed');
      } finally {
        imageInput.value = '';
        imageButton.disabled = false;
        imageButton.textContent = 'Insert image';
      }
    });
  }
})();
