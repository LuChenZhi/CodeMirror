import { Display } from "../display/Display";
import { onFocus, onBlur } from "../display/focus";
import { setGuttersForLineNumbers, updateGutters } from "../display/gutters";
import { maybeUpdateLineNumberWidth } from "../display/line_numbers";
import { endOperation, operation, startOperation } from "../display/operations";
import { initScrollbars } from "../display/scrollbars";
import { onScrollWheel, setScrollLeft, setScrollTop } from "../display/scroll_events";
import { clipPos, Pos } from "../line/pos";
import { posFromMouse } from "../measurement/position_measurement";
import { eventInWidget } from "../measurement/widgets";
import Doc from "../model/Doc";
import { attachDoc } from "../model/document_data";
import { Range } from "../model/selection";
import { extendSelection } from "../model/selection_updates";
import { captureRightClick, ie, ie_version, mobile, webkit } from "../util/browser";
import { e_preventDefault, e_stop, on, signal, signalDOMEvent } from "../util/event";
import { bind, copyObj, Delayed } from "../util/misc";

import { clearDragCursor, onDragOver, onDragStart, onDrop } from "./drop_events";
import { ensureGlobalHandlers } from "./global_events";
import { onKeyDown, onKeyPress, onKeyUp } from "./key_events";
import { clickInGutter, onContextMenu, onMouseDown } from "./mouse_events";
import { themeChanged } from "./utils";
import { defaults, optionHandlers, Init } from "./options";

// A CodeMirror instance represents an editor. This is the object
// that user code is usually dealing with.

export function CodeMirror(place, options) {
  if (!(this instanceof CodeMirror)) return new CodeMirror(place, options);

  this.options = options = options ? copyObj(options) : {};
  // Determine effective options based on given values and defaults.
  copyObj(defaults, options, false);
  setGuttersForLineNumbers(options);

  var doc = options.value;
  if (typeof doc == "string") doc = new Doc(doc, options.mode, null, options.lineSeparator);
  this.doc = doc;

  var input = new CodeMirror.inputStyles[options.inputStyle](this);
  var display = this.display = new Display(place, doc, input);
  display.wrapper.CodeMirror = this;
  updateGutters(this);
  themeChanged(this);
  if (options.lineWrapping)
    this.display.wrapper.className += " CodeMirror-wrap";
  if (options.autofocus && !mobile) display.input.focus();
  initScrollbars(this);

  this.state = {
    keyMaps: [],  // stores maps added by addKeyMap
    overlays: [], // highlighting overlays, as added by addOverlay
    modeGen: 0,   // bumped when mode/overlay changes, used to invalidate highlighting info
    overwrite: false,
    delayingBlurEvent: false,
    focused: false,
    suppressEdits: false, // used to disable editing during key handlers when in readOnly mode
    pasteIncoming: false, cutIncoming: false, // help recognize paste/cut edits in input.poll
    selectingText: false,
    draggingText: false,
    highlight: new Delayed(), // stores highlight worker timeout
    keySeq: null,  // Unfinished key sequence
    specialChars: null
  };

  var cm = this;

  // Override magic textarea content restore that IE sometimes does
  // on our hidden textarea on reload
  if (ie && ie_version < 11) setTimeout(function() { cm.display.input.reset(true); }, 20);

  registerEventHandlers(this);
  ensureGlobalHandlers();

  startOperation(this);
  this.curOp.forceUpdate = true;
  attachDoc(this, doc);

  if ((options.autofocus && !mobile) || cm.hasFocus())
    setTimeout(bind(onFocus, this), 20);
  else
    onBlur(this);

  for (var opt in optionHandlers) if (optionHandlers.hasOwnProperty(opt))
    optionHandlers[opt](this, options[opt], Init);
  maybeUpdateLineNumberWidth(this);
  if (options.finishInit) options.finishInit(this);
  for (var i = 0; i < initHooks.length; ++i) initHooks[i](this);
  endOperation(this);
  // Suppress optimizelegibility in Webkit, since it breaks text
  // measuring on line wrapping boundaries.
  if (webkit && options.lineWrapping &&
      getComputedStyle(display.lineDiv).textRendering == "optimizelegibility")
    display.lineDiv.style.textRendering = "auto";
}

// The default configuration options.
CodeMirror.defaults = defaults;
// Functions to run when options are changed.
CodeMirror.optionHandlers = optionHandlers;

export default CodeMirror;

// Attach the necessary event handlers when initializing the editor
function registerEventHandlers(cm) {
  var d = cm.display;
  on(d.scroller, "mousedown", operation(cm, onMouseDown));
  // Older IE's will not fire a second mousedown for a double click
  if (ie && ie_version < 11)
    on(d.scroller, "dblclick", operation(cm, function(e) {
      if (signalDOMEvent(cm, e)) return;
      var pos = posFromMouse(cm, e);
      if (!pos || clickInGutter(cm, e) || eventInWidget(cm.display, e)) return;
      e_preventDefault(e);
      var word = cm.findWordAt(pos);
      extendSelection(cm.doc, word.anchor, word.head);
    }));
  else
    on(d.scroller, "dblclick", function(e) { signalDOMEvent(cm, e) || e_preventDefault(e); });
  // Some browsers fire contextmenu *after* opening the menu, at
  // which point we can't mess with it anymore. Context menu is
  // handled in onMouseDown for these browsers.
  if (!captureRightClick) on(d.scroller, "contextmenu", function(e) {onContextMenu(cm, e);});

  // Used to suppress mouse event handling when a touch happens
  var touchFinished, prevTouch = {end: 0};
  function finishTouch() {
    if (d.activeTouch) {
      touchFinished = setTimeout(function() {d.activeTouch = null;}, 1000);
      prevTouch = d.activeTouch;
      prevTouch.end = +new Date;
    }
  }
  function isMouseLikeTouchEvent(e) {
    if (e.touches.length != 1) return false;
    var touch = e.touches[0];
    return touch.radiusX <= 1 && touch.radiusY <= 1;
  }
  function farAway(touch, other) {
    if (other.left == null) return true;
    var dx = other.left - touch.left, dy = other.top - touch.top;
    return dx * dx + dy * dy > 20 * 20;
  }
  on(d.scroller, "touchstart", function(e) {
    if (!signalDOMEvent(cm, e) && !isMouseLikeTouchEvent(e)) {
      clearTimeout(touchFinished);
      var now = +new Date;
      d.activeTouch = {start: now, moved: false,
                       prev: now - prevTouch.end <= 300 ? prevTouch : null};
      if (e.touches.length == 1) {
        d.activeTouch.left = e.touches[0].pageX;
        d.activeTouch.top = e.touches[0].pageY;
      }
    }
  });
  on(d.scroller, "touchmove", function() {
    if (d.activeTouch) d.activeTouch.moved = true;
  });
  on(d.scroller, "touchend", function(e) {
    var touch = d.activeTouch;
    if (touch && !eventInWidget(d, e) && touch.left != null &&
        !touch.moved && new Date - touch.start < 300) {
      var pos = cm.coordsChar(d.activeTouch, "page"), range;
      if (!touch.prev || farAway(touch, touch.prev)) // Single tap
        range = new Range(pos, pos);
      else if (!touch.prev.prev || farAway(touch, touch.prev.prev)) // Double tap
        range = cm.findWordAt(pos);
      else // Triple tap
        range = new Range(Pos(pos.line, 0), clipPos(cm.doc, Pos(pos.line + 1, 0)));
      cm.setSelection(range.anchor, range.head);
      cm.focus();
      e_preventDefault(e);
    }
    finishTouch();
  });
  on(d.scroller, "touchcancel", finishTouch);

  // Sync scrolling between fake scrollbars and real scrollable
  // area, ensure viewport is updated when scrolling.
  on(d.scroller, "scroll", function() {
    if (d.scroller.clientHeight) {
      setScrollTop(cm, d.scroller.scrollTop);
      setScrollLeft(cm, d.scroller.scrollLeft, true);
      signal(cm, "scroll", cm);
    }
  });

  // Listen to wheel events in order to try and update the viewport on time.
  on(d.scroller, "mousewheel", function(e){onScrollWheel(cm, e);});
  on(d.scroller, "DOMMouseScroll", function(e){onScrollWheel(cm, e);});

  // Prevent wrapper from ever scrolling
  on(d.wrapper, "scroll", function() { d.wrapper.scrollTop = d.wrapper.scrollLeft = 0; });

  d.dragFunctions = {
    enter: function(e) {if (!signalDOMEvent(cm, e)) e_stop(e);},
    over: function(e) {if (!signalDOMEvent(cm, e)) { onDragOver(cm, e); e_stop(e); }},
    start: function(e){onDragStart(cm, e);},
    drop: operation(cm, onDrop),
    leave: function(e) {if (!signalDOMEvent(cm, e)) { clearDragCursor(cm); }}
  };

  var inp = d.input.getField();
  on(inp, "keyup", function(e) { onKeyUp.call(cm, e); });
  on(inp, "keydown", operation(cm, onKeyDown));
  on(inp, "keypress", operation(cm, onKeyPress));
  on(inp, "focus", function(e) { onFocus(cm, e); });
  on(inp, "blur", function (e) { onBlur(cm, e); });
}

var initHooks = [];
CodeMirror.defineInitHook = function(f) {initHooks.push(f);};