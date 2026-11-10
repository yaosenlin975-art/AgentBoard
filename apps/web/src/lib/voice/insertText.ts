/**
 * 语音文本插入（VOICE-3）：插到光标处（有选中则替换），派发一次 `input` 让受控组件同步，
 * 光标落在插入文本末尾，且**一次 Ctrl+Z 能整体撤销**。
 *
 * 为什么用 `document.execCommand('insertText')`：
 * - 浏览器把它当作「用户输入编辑」记入 undo 栈 —— React 受控 textarea/input 也能吃到 input 事件，
 *   天然得到「一次插入 = 一步撤销」；用 setter + 手工 dispatch input 只会改值，不进原生 undo 栈，
 *   Ctrl+Z 会变成「撤销到上一次整块重渲染」，不符合需求。
 * - contenteditable 同样适用。
 * - 不可用（部分环境已废弃/无实现）时回退到 setter + input 事件，行为可用但撤销粒度退化（已注明）。
 */

export interface InsertResult {
  ok: boolean;
  /** 插入方式，便于测试断言 */
  method: 'execCommand' | 'setter' | 'unsupported';
  /** 插入后光标位置（字符偏移；contenteditable 为 null） */
  caret: number | null;
}

function insertIntoInput(el: HTMLInputElement | HTMLTextAreaElement, text: string): InsertResult {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.focus();

  if (typeof document.execCommand === 'function') {
    try {
      const before = el.value;
      el.setSelectionRange(start, end);
      const ok = document.execCommand('insertText', false, text);
      // 少数宿主（WebView/权限受限的富文本）会返回 true 但值没变：不能当成插入成功
      if (ok && el.value !== before) {
        const caret = start + text.length;
        el.setSelectionRange(caret, caret);
        return { ok: true, method: 'execCommand', caret };
      }
    } catch {
      // 落到 setter 回退
    }
  }

  const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (setter !== undefined) setter.call(el, next);
  else el.value = next;
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true, method: 'setter', caret };
}

function insertIntoEditable(el: HTMLElement, text: string): InsertResult {
  el.focus();
  if (typeof document.execCommand === 'function') {
    try {
      if (document.execCommand('insertText', false, text)) return { ok: true, method: 'execCommand', caret: null };
    } catch {
      // 落到 Range 回退
    }
  }
  const selection = window.getSelection();
  if (selection !== null && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return { ok: true, method: 'setter', caret: null };
  }
  el.append(document.createTextNode(text));
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  return { ok: true, method: 'setter', caret: null };
}

/** 把 text 插入到元素当前光标处；无光标时追加到末尾 */
export function insertVoiceText(el: HTMLElement, text: string): InsertResult {
  if (text === '') return { ok: false, method: 'unsupported', caret: null };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return insertIntoInput(el, text);
  if (el.isContentEditable) return insertIntoEditable(el, text);
  return { ok: false, method: 'unsupported', caret: null };
}
