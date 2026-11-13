/* Accessible dropdowns that keep the underlying select as the source of truth. */
(() => {
  let openDropdown = null;
  function enhance(select, kind) {
    const root = document.createElement('div');
    root.className = `dropdown dropdown--${kind}`;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dropdown-trigger';
    trigger.id = `${select.id}-trigger`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', kind === 'model' ? 'Choose model' : 'Router');
    const label = document.createElement('span');
    label.className = 'dropdown-value';
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<path d="m7 10 5 5 5-5"/>';
    trigger.append(label, arrow);
    const panel = document.createElement('div');
    panel.className = 'dropdown-panel';
    panel.hidden = true;
    const heading = document.createElement('div');
    heading.className = 'dropdown-heading';
    heading.textContent = kind === 'model' ? 'AVAILABLE MODELS' : 'SELECT ROUTER';
    const list = document.createElement('div');
    list.className = 'dropdown-options';
    list.id = `${select.id}-options`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', kind === 'model' ? 'Available models' : 'Router options');
    trigger.setAttribute('aria-controls', list.id);
    panel.append(heading, list);
    select.insertAdjacentElement('afterend', root);
    root.append(trigger, panel);
    select.classList.add('select-enhanced');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    const associatedLabel = document.querySelector(`label[for="${select.id}"]`);
    if (associatedLabel) associatedLabel.htmlFor = trigger.id;
    const close = (restoreFocus = false) => {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (openDropdown === close) openDropdown = null;
      if (restoreFocus) trigger.focus();
    };
    function sync() {
      const selected = select.selectedOptions[0];
      label.textContent = selected?.textContent || 'Select an option';
      trigger.title = label.textContent;
      trigger.setAttribute('aria-label', `${kind === 'model' ? 'Choose model' : 'Router'}: ${label.textContent}`);
      list.replaceChildren();
      [...select.options].forEach(option => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dropdown-option';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.selected));
        item.disabled = option.disabled;
        item.tabIndex = -1;
        const name = document.createElement('span');
        name.textContent = option.textContent;
        const check = document.createElement('span');
        check.className = 'dropdown-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = '✓';
        item.append(name, check);
        item.addEventListener('click', () => {
          select.value = option.value;
          select.dispatchEvent(new Event('change', {bubbles: true}));
          sync();
          close(true);
        });
        list.append(item);
      });
    }
    function show(focusOption = false) {
      if (openDropdown && openDropdown !== close) openDropdown();
      sync();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      openDropdown = close;
      if (focusOption) (list.querySelector('[aria-selected="true"]:not(:disabled)') || list.querySelector('button:not(:disabled)'))?.focus();
    }
    trigger.addEventListener('click', () => panel.hidden ? show() : close());
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(true); }
      if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); close(true); }
    });
    list.addEventListener('keydown', event => {
      const items = [...list.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close();
    });
    document.addEventListener('pointerdown', event => { if (!root.contains(event.target)) close(); });
    select.addEventListener('change', sync);
    new MutationObserver(sync).observe(select, {childList: true, subtree: true, attributes: true});
    if (kind === 'router') new MutationObserver(() => { if (!document.getElementById('settings-modal').hidden) sync(); else close(); }).observe(document.getElementById('settings-modal'), {attributes: true, attributeFilter: ['hidden']});
    sync();
  }
  enhance(document.getElementById('model-select'), 'model');
  enhance(document.getElementById('router-preset'), 'router');
})();
