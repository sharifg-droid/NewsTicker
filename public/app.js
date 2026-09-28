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

  let selectedFigure = null;

  if (toolbar && editor) {
    const controls = document.createElement('span');
    controls.className = 'image-controls';
    controls.dataset.imageControls = '';
    controls.innerHTML =
      '<span class="image-controls-label">Image:</span>' +
      '<button type="button" data-image-size="25">25%</button>' +
      '<button type="button" data-image-size="40">40%</button>' +
      '<button type="button" data-image-size="60">60%</button>' +
      '<button type="button" data-image-size="100">100%</button>' +
      '<button type="button" data-image-align="left">Wrap left</button>' +
      '<button type="button" data-image-align="right">Wrap right</button>' +
      '<button type="button" data-image-align="block">Top / bottom</button>';
    toolbar.appendChild(controls);

    const selectFigure = (figure) => {
      editor.querySelectorAll('figure.image-selected').forEach(el => el.classList.remove('image-selected'));
      selectedFigure = figure || null;
      if (selectedFigure) selectedFigure.classList.add('image-selected');
      controls.classList.toggle('active', Boolean(selectedFigure));
    };

    editor.addEventListener('click', (event) => {
      const image = event.target.closest('img');
      const figure = image ? image.closest('figure') : null;
      if (figure && editor.contains(figure)) selectFigure(figure);
      else if (!event.target.closest('[data-image-controls]')) selectFigure(null);
    });

    controls.addEventListener('click', (event) => {
      const sizeButton = event.target.closest('[data-image-size]');
      const alignButton = event.target.closest('[data-image-align]');
      if (!selectedFigure || (!sizeButton && !alignButton)) return;
      event.preventDefault();

      if (sizeButton) {
        selectedFigure.classList.remove('image-size-25','image-size-40','image-size-60','image-size-100');
        selectedFigure.classList.add('image-size-' + sizeButton.dataset.imageSize);
      }

      if (alignButton) {
        selectedFigure.classList.remove('image-wrap-left','image-wrap-right','image-block');
        const mode = alignButton.dataset.imageAlign;
        selectedFigure.classList.add(mode === 'left' ? 'image-wrap-left' : mode === 'right' ? 'image-wrap-right' : 'image-block');
      }
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
          '<figure class="image-size-60 image-block"><img src="' + result.url + '" alt=""><figcaption>Image caption</figcaption></figure><p><br></p>'
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
