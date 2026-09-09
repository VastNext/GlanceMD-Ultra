(function (root) {
  'use strict';

  function getScroller() {
    return document.getElementById('preview-wrapper');
  }

  function clampScrollTop(scroller, top) {
    var max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return Math.max(0, Math.min(max, Number(top) || 0));
  }

  function scrollToTop(top, behavior) {
    var scroller = getScroller();
    if (!scroller) return false;
    var target = clampScrollTop(scroller, top);
    if (behavior === 'smooth' && typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      scroller.scrollTop = target;
    }
    return true;
  }

  function scrollToElement(element, options) {
    var scroller = getScroller();
    if (!scroller || !element || typeof element.getBoundingClientRect !== 'function') return false;
    options = options || {};
    var scrollerRect = scroller.getBoundingClientRect();
    var elementRect = element.getBoundingClientRect();
    var block = options.block || 'center';
    var target = scroller.scrollTop + elementRect.top - scrollerRect.top;
    if (block === 'center') {
      target -= Math.max(0, (scroller.clientHeight - elementRect.height) / 2);
    } else if (block === 'end') {
      target -= Math.max(0, scroller.clientHeight - elementRect.height);
    } else if (block === 'nearest') {
      var visibleTop = elementRect.top - scrollerRect.top;
      var visibleBottom = elementRect.bottom - scrollerRect.top;
      if (visibleTop >= 0 && visibleBottom <= scroller.clientHeight) return true;
      if (visibleBottom > scroller.clientHeight) {
        target -= Math.max(0, scroller.clientHeight - elementRect.height);
      }
    }
    return scrollToTop(target, options.behavior);
  }

  function getScrollRatio() {
    var scroller = getScroller();
    if (!scroller) return 0;
    var max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return max > 0 ? Math.max(0, Math.min(1, scroller.scrollTop / max)) : 0;
  }

  function scrollToRatio(ratio) {
    var scroller = getScroller();
    if (!scroller) return false;
    var max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return scrollToTop(max * Math.max(0, Math.min(1, Number(ratio) || 0)));
  }

  function scrollByPage(direction) {
    var scroller = getScroller();
    if (!scroller) return false;
    var delta = (direction >= 0 ? 1 : -1) * Math.max(40, (scroller.clientHeight || 400) - 40);
    return scrollToTop(scroller.scrollTop + delta);
  }

  function focus() {
    var scroller = getScroller();
    if (!scroller || typeof scroller.focus !== 'function') return false;
    if (!scroller.hasAttribute('tabindex')) scroller.setAttribute('tabindex', '0');
    scroller.focus();
    return true;
  }

  root.PreviewNavigation = {
    getScroller: getScroller,
    getScrollTop: function () {
      var scroller = getScroller();
      return scroller ? scroller.scrollTop : 0;
    },
    setScrollTop: function (top) { return scrollToTop(top); },
    getScrollRatio: getScrollRatio,
    scrollToRatio: scrollToRatio,
    scrollToElement: scrollToElement,
    scrollByPage: scrollByPage,
    focus: focus
  };
})(typeof window !== 'undefined' ? window : globalThis);
