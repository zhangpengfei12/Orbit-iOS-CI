/**
 * 通用自定义下拉选择器：把原生 <select> 包装成玻璃拟态下拉面板。
 * 保留原 select 作为数据源/事件源，外部监听 change 事件无需改动。
 */
(function () {
    function closest(el, cls) {
        while (el && el !== document.body) {
            if (el.classList && el.classList.contains(cls)) return el;
            el = el.parentNode;
        }
        return null;
    }

    function updateDisplay(wrap, sel) {
        var label = wrap.querySelector('.custom-select__label');
        var items = wrap.querySelectorAll('.custom-select__item');
        var opt = sel.options[sel.selectedIndex];
        if (label && opt) label.textContent = opt.textContent || '';
        items.forEach(function (item) {
            var isSel = item.dataset.value === sel.value;
            item.classList.toggle('is-selected', isSel);
            var radio = item.querySelector('.custom-select__radio');
            if (radio) radio.classList.toggle('is-checked', isSel);
        });
    }

    function closeAll() {
        document.querySelectorAll('.custom-select.is-open').forEach(function (w) {
            w.classList.remove('is-open');
        });
    }

    function positionDropdown(wrap, dropdown) {
        var rect = wrap.getBoundingClientRect();
        dropdown.style.width = Math.max(rect.width, 180) + 'px';
        var top = rect.bottom + 4;
        var maxH = 280;
        if (top + maxH > window.innerHeight - 16) {
            top = Math.max(16, rect.top - maxH - 4);
        }
        dropdown.style.top = top + 'px';
        var left = rect.left;
        if (left + parseInt(dropdown.style.width || rect.width) > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - parseInt(dropdown.style.width || rect.width) - 8);
        }
        dropdown.style.left = left + 'px';
    }

    function buildDropdown(wrap, sel) {
        var dropdown = document.createElement('div');
        dropdown.className = 'custom-select__dropdown';
        var items = document.createElement('div');
        items.className = 'custom-select__items';
        for (var i = 0; i < sel.options.length; i++) {
            var opt = sel.options[i];
            var item = document.createElement('div');
            item.className = 'custom-select__item' + (opt.selected ? ' is-selected' : '');
            item.dataset.value = opt.value;
            item.dataset.index = i;
            var radio = document.createElement('span');
            radio.className = 'custom-select__radio' + (opt.selected ? ' is-checked' : '');
            var text = document.createElement('span');
            text.className = 'custom-select__text';
            text.textContent = opt.textContent || '';
            item.appendChild(radio);
            item.appendChild(text);
            item.addEventListener('click', function (e) {
                e.stopPropagation();
                var idx = parseInt(this.dataset.index, 10);
                sel.selectedIndex = idx;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                updateDisplay(wrap, sel);
                closeAll();
            });
            items.appendChild(item);
        }
        dropdown.appendChild(items);
        return dropdown;
    }

    function wrapSelect(sel) {
        if (sel.dataset.customReady) return;
        sel.dataset.customReady = '1';
        sel.style.display = 'none';
        var wrap = document.createElement('div');
        wrap.className = 'custom-select';
        var trigger = document.createElement('div');
        trigger.className = 'custom-select__trigger';
        trigger.innerHTML = '<span class="custom-select__label"></span>' +
            '<svg class="custom-select__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M6 9l6 6 6-6"/>' +
            '</svg>';
        var dropdown = buildDropdown(wrap, sel);
        wrap.appendChild(trigger);
        wrap.appendChild(dropdown);
        sel.parentNode.insertBefore(wrap, sel);

        trigger.addEventListener('click', function (e) {
            e.stopPropagation();
            if (wrap.classList.contains('is-open')) {
                closeAll();
                return;
            }
            closeAll();
            wrap.classList.add('is-open');
            positionDropdown(wrap, dropdown);
            var selected = dropdown.querySelector('.custom-select__item.is-selected');
            if (selected) selected.scrollIntoView({ block: 'nearest' });
        });

        sel.addEventListener('change', function () {
            updateDisplay(wrap, sel);
        });

        // 外部脚本直接改 select.value / 重建 option 时，同步显示
        try {
            var mo = new MutationObserver(function () {
                updateDisplay(wrap, sel);
            });
            mo.observe(sel, {
                attributes: true,
                attributeFilter: ['value', 'selected', 'selectedIndex'],
                childList: true,
                subtree: true
            });
            wrap._mo = mo;
        } catch (e) { /* 不支持则忽略，仅交互时更新 */ }

        updateDisplay(wrap, sel);
    }

    window.initCustomSelects = function (root) {
        var scope = root || document;
        scope.querySelectorAll('select.form-input, select.osr-debug-select, select[data-custom]').forEach(wrapSelect);
    };

    document.addEventListener('click', function (e) {
        if (!closest(e.target, 'custom-select')) closeAll();
    });

    window.addEventListener('scroll', closeAll, { passive: true });
    window.addEventListener('resize', closeAll, { passive: true });

    function boot() {
        window.initCustomSelects(document);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
