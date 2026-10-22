const hoveredClassName = 'hovered';

// Check if the provided object is an HTML element
function isHtmlElement(el) {
  return (typeof HTMLElement !== 'undefined') && el instanceof HTMLElement;
}

// Resolve various target types to an actual HTML element
function resolveElement(target) {
  // If no target is provided, return null
  if (!target) {
    console.error('%c[navigation.js, resolveElement]', 'color: gray;', 'No target element is provided!', target);
    return null;
  }
  // If the target is already an HTML element, return it directly
  if (isHtmlElement(target)) {
    return target;
  }
  // If the target is a string, treat it as an element ID
  if (typeof target === 'string') {
    return document.getElementById(target);
  }
  // If the target is an array-like object, return the first element
  if (target && target[0] && target[0].nodeType === 1) {
    return target[0];
  }
  // If the target is a DOM node, return it directly
  if (target && target.nodeType === 1) {
    return target;
  }
  // If the target is a wrapper object exposing an 'element' property, return that
  if (target && target.element && isHtmlElement(target.element)) {
    return target.element;
  }
  // If the target is a wrapper object exposing an 'el' property, return that
  if (target && target.el && isHtmlElement(target.el)) {
    return target.el;
  }
  // If the target is a string containing an element ID, retrieve the element by that ID
  if (target && typeof target.id === 'string') {
    return document.getElementById(target.id);
  }
  // If the target cannot be resolved to an element, return null
  console.warn('%c[navigation.js, resolveElement]', 'color: gray;', 'Target element cannot be resolved:', target);
  return null;
}

// Click the target element from the resolved element
function clickElement(target) {
  const element = resolveElement(target);
  // Check if the element exists before clicking
  if (!element) {
    console.error('%c[navigation.js, clickElement]', 'color: gray;', 'Cannot click the unresolved target:', target);
    return;
  }
  // Prevent clicking if the element is disabled based on common disabled states
  if (element.disabled || element.getAttribute('aria-disabled') === 'true' || element.classList.contains('is-disabled')) {
    console.warn('%c[navigation.js, clickElement]', 'color: gray;', 'Cannot click the disabled target element:', element);
    // Check if the disabled element is the Game Mode switch
    if (element.id === 'gameModeBtn' && parseFloat(platformVer) === 5.5) {
      // Show a warning message when attempting to enable game mode on Tizen 5.5 platform
      setTimeout(() => {
        warningDialog(t('Unsupported Feature'),
          t('Game Mode (Ultra Low Latency) is not supported on Tizen %1$s due to platform limitations and lack of support from the WASM player.', platformVer) +
          t('Attempting to enable this option will have no effect, as the decoder will force a fallback to standard Low Latency mode to maintain streaming stability.<br><br>') +
          t('Since the Game Mode cannot be enabled, you may experience slightly higher latency while streaming. To further reduce latency, it is highly recommended to open your TV\'s Picture Settings menu and disable post-processing features such as <b>Picture Clarity</b>, <b>Contrast Enhancer</b>, and other video enhancements.')
        );
      }, 250);
    }
    return;
  }
  // If inside an MDL menu, use the menu item itself for proper behavior
  const menuItem = element.closest ? element.closest('.mdl-menu__item') : null;
  // If a clickable menu item is found, use it instead of the container
  if (menuItem && typeof menuItem.click === 'function') {
    menuItem.click();
    return;
  }
  // Search for common toggle switch child elements within the target element
  const toggleSwitch = element.querySelector('input[type="checkbox"], .mdl-switch__input, [role="switch"], [aria-pressed]');
  // If a clickable child element is found, use it to trigger animations
  if (toggleSwitch && typeof toggleSwitch.click === 'function') {
    // Dispatching events for MDL ripple animations
    const eventOptions = { view: window, bubbles: true, cancelable: true };
    toggleSwitch.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    toggleSwitch.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    setTimeout(() => focusElement(toggleSwitch), 250);
  }
  // Click the resolved element itself if it supports click event
  if (typeof element.click === 'function') {
    element.click();
  }
}

// Mark an element based on various target types
function mark(target) {
  if (target === undefined || target === null) return;
  const element = resolveElement(target);
  // Check if the element exists before marking
  if (element) {
    // Add the hovered class and dispatch the event
    element.classList.add(hoveredClassName);
    element.dispatchEvent(new Event('mouseenter'));
  } else {
    console.error('%c[navigation.js, mark]', 'color: gray;', 'Cannot mark the unresolved target:', target);
  }
}

// Unmark an element based on various target types
function unmark(target) {
  if (target === undefined || target === null) return;
  const element = resolveElement(target);
  // Check if the element exists before un-marking
  if (element) {
    // Remove the hovered class and dispatch the event
    element.classList.remove(hoveredClassName);
    element.dispatchEvent(new Event('mouseleave'));
  } else {
    console.error('%c[navigation.js, unmark]', 'color: gray;', 'Cannot unmark the unresolved target:', target);
  }
}

// Get the current ID of a target element
function elementId(target) {
  const element = resolveElement(target);
  // Check if the element exists and has an ID
  if (element && element.id) {
    return element.id;
  }
  // If the target is a string, return it directly
  return typeof target === 'string' ? target : '';
}

// Safely add focus to an element
function focusElement(target) {
  if (target === undefined || target === null) return;
  const element = resolveElement(target);
  const listener = document.getElementById('listener');
  // Remove focus from the currently focused element first
  blurElement(document.activeElement);
  // Check if the element exists before adding focus
  if (!element) {
    console.error('%c[navigation.js, focusElement]', 'color: gray;', 'Cannot focus the unresolved target:', target);
    return;
  }
  // Check if the element is a SELECT dropdown
  if (element.tagName === 'SELECT') {
    // Delegate focus to the hidden listener element
    if (listener && typeof listener.focus === 'function') {
      listener.focus();
    }
    return;
  }
  // If the element supports focus, add focus to it
  if (typeof element.focus === 'function') {
    element.focus();
  }
}

// Bring an element of a row to the middle of the row. Only the row moves, the page does not
function centerInRow(target, behavior) {
  if (target === undefined || target === null) return;
  const element = resolveElement(target);
  if (!element || typeof element.scrollIntoView !== 'function') return;
  element.scrollIntoView({ behavior: behavior, block: 'nearest', inline: 'center' });
}

// Focus a tile of a row and bring it to the middle. The focus is given without the scroll of the browser, which would only
// make the tile visible and then fight with the move to the middle
function focusTile(target, behavior) {
  if (target === undefined || target === null) return;
  const element = resolveElement(target);
  if (!element) return;
  blurElement(document.activeElement);
  if (typeof element.focus === 'function') {
    element.focus({ preventScroll: true });
  }
  centerInRow(element, behavior);
}

// Safely remove focus from an element
function blurElement(target) {
  if (target === undefined || target === null) return;
  const element = resolveElement(target);
  // Check if the element exists before removing focus
  if (!element) {
    console.error('%c[navigation.js, blurElement]', 'color: gray;', 'Cannot blur the unresolved target:', target);
    return;
  }
  // If the element supports blur, remove focus from it
  if (typeof element.blur === 'function') {
    element.blur();
  }
}

// Determine if a popup menu container is active
function isPopupMenuActive(id) {
  const element = resolveElement(id);
  const parent = element ? element.parentNode : null;
  const container = parent && parent.querySelector ? parent.querySelector('.mdl-menu__container') : null;
  // Check if the container exists and is visible
  return !!(container && container.classList.contains('is-visible'));
}

// Close any active visible menu containers
function closeActiveVisibleMenu() {
  const visibleMenuContainer = document.querySelectorAll('.mdl-menu__container.is-visible');
  // If no visible menus are found, return false
  if (!visibleMenuContainer || visibleMenuContainer.length === 0) {
    return false;
  }
  // Hide each visible menu using its MaterialMenu instance
  visibleMenuContainer.forEach((menu) => {
    const visibleMenu = menu.querySelector('.mdl-menu');
    // Ensure the menu and its MaterialMenu instance exist before hiding
    if (visibleMenu && visibleMenu.MaterialMenu && typeof visibleMenu.MaterialMenu.hide === 'function') {
      visibleMenu.MaterialMenu.hide();
    }
  });
  // Simulate an Escape key press to close menus that rely on it
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', keyCode: 27, which: 27, bubbles: true
  }));
  // Trigger a click on the body to ensure menus are closed
  if (document.body) {
    document.body.click();
  }
  Navigation.pop();
  return true;
}

// Close a specific popup menu container by its ID
function closePopupMenu(id) {
  // If the specified menu is active, click its opener to close it
  if (isPopupMenuActive(id)) {
    // Close the popup menu by clicking its opener element
    clickElement(id);
    return true;
  }
  return closeActiveVisibleMenu();
}

// Handle the state of the IP address text input field
function handleIpTextFieldState(enabled) {
  const listener = document.getElementById('listener');
  const textInput = document.getElementById('ipAddressTextInput');
  // Check if the element exists before modifying
  if (!textInput) {
    console.error('%c[navigation.js, handleIpTextFieldState]', 'color: gray;', 'Cannot find the IP address text input element!', textInput);
    return;
  }
  textInput.readOnly = !enabled;
  // Set or remove focus based on the enabled state
  if (enabled) {
    textInput.focus();
    // Trigger a click to open the virtual keyboard on Tizen devices
    if (typeof textInput.click === 'function') {
      textInput.click();
    }
  } else {
    textInput.blur();
    // In case of blur, set focus back to the hidden listener element
    if (typeof listener.focus === 'function') {
      listener.focus();
    }
  }
}

// The fields of the diagnostic receiver are read-only while they only have the focus, so that the keyboard of the TV does not
// open by itself on the way through the list; A makes one of them typeable, and the end of the typing makes it read-only again
function handleDiagnosticFieldState(target, enabled) {
  const field = resolveElement(target);
  if (!field) return;
  field.readOnly = !enabled;
  if (enabled) {
    field.focus();
    // Trigger a click to open the virtual keyboard on Tizen devices
    if (typeof field.click === 'function') {
      field.click();
    }
  } else {
    field.blur();
  }
}

// Change the value of the IP address numeric field
function changeIpNumericFieldValue(adjust) {
  const currentItem = elementId(this.view.current());
  if (currentItem.startsWith('ipAddressField')) {
    const digitElement = document.getElementById(currentItem);
    let currentValue = parseInt(digitElement.value, 10);
    currentValue = (currentValue + adjust + 256) % 256;
    digitElement.value = currentValue;
    digitElement.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

class ListView {
  constructor(func) {
    this.index = 0;
    this.func = func;
  }

  current() {
    const array = this.normalize();
    return array[this.index];
  }

  normalize() {
    const array = this.func() || [];
    if (array.length === 0) {
      this.index = 0;
      return array;
    }
    this.index = Math.max(0, Math.min(this.index, array.length - 1));
    return array;
  }

  prev() {
    const array = this.normalize();
    if (array.length === 0) return undefined;
    if (this.index > 0) {
      unmark(array[this.index]);
      --this.index;
      mark(array[this.index]);
    }
    return array[this.index];
  }

  next() {
    const array = this.normalize();
    if (array.length === 0) return undefined;
    if (this.index < array.length - 1) {
      unmark(array[this.index]);
      ++this.index;
      mark(array[this.index]);
    }
    return array[this.index];
  }

  prevCategory() {
    const array = this.normalize();
    if (array.length === 0) return false;
    if (this.index > 0) {
      unmark(array[this.index]);
      --this.index;
      mark(array[this.index]);
      // Indicate that there are more categories
      return true;
    }
    // Indicate that there are no more categories
    return false;
  }

  nextCategory() {
    const array = this.normalize();
    if (array.length === 0) return false;
    if (this.index < array.length - 1) {
      unmark(array[this.index]);
      ++this.index;
      mark(array[this.index]);
      // Indicate that there are more categories
      return true;
    }
    // Indicate that there are no more categories
    return false;
  }

  prevOption() {
    const array = this.normalize();
    if (array.length === 0) return undefined;
    unmark(array[this.index]);
    this.index = (this.index - 1 + array.length) % array.length;
    mark(array[this.index]);
    return array[this.index];
  }

  nextOption() {
    const array = this.normalize();
    if (array.length === 0) return undefined;
    unmark(array[this.index]);
    this.index = (this.index + 1) % array.length;
    mark(array[this.index]);
    return array[this.index];
  }

  prevCard(cardsPerRow) {
    const array = this.normalize();
    if (array.length === 0) return undefined;
    const currentRow = Math.floor(this.index / cardsPerRow);
    // Check if a previous card exists
    if (this.index > 0) {
      unmark(array[this.index]);
      --this.index;
      const newRow = Math.floor(this.index / cardsPerRow);
      mark(array[this.index]);
      if (newRow !== currentRow) {
        this.scrollToCardRow(newRow, cardsPerRow);
      }
    }
    return array[this.index];
  }

  nextCard(cardsPerRow) {
    const array = this.normalize();
    if (array.length === 0) return undefined;
    const currentRow = Math.floor(this.index / cardsPerRow);
    // Check if a next card exists
    if (this.index < array.length - 1) {
      unmark(array[this.index]);
      ++this.index;
      const newRow = Math.floor(this.index / cardsPerRow);
      mark(array[this.index]);
      if (newRow !== currentRow) {
        this.scrollToCardRow(newRow, cardsPerRow);
      }
    }
    return array[this.index];
  }

  currentCardRow(cardsPerRow) {
    const array = this.normalize();
    // Check if there are any card in the current row
    if (!array || array.length === 0) {
      return;
    }
    // Determine the current row based on the index
    const currentRow = Math.floor(this.index / cardsPerRow);
    // Scroll to the row containing the current card
    this.scrollToCardRow(currentRow, cardsPerRow);
  }

  prevCardRow(cardsPerRow) {
    const array = this.normalize();
    if (array.length === 0) return false;
    const currentRow = Math.floor(this.index / cardsPerRow);
    // Check if a previous card row exists
    if (currentRow > 0) {
      unmark(array[this.index]);
      this.index = Math.max(0, this.index - cardsPerRow);
      mark(array[this.index]);
      this.scrollToCardRow(currentRow - 1, cardsPerRow);
      // Indicate that there are more card rows
      return true;
    }
    // Indicate that there are no more card rows
    return false;
  }

  nextCardRow(cardsPerRow) {
    const array = this.normalize();
    if (array.length === 0) return false;
    const rows = Math.ceil(array.length / cardsPerRow);
    const currentRow = Math.floor(this.index / cardsPerRow);
    // Check if a next card row exists
    if (currentRow < rows - 1) {
      unmark(array[this.index]);
      this.index = Math.min(array.length - 1, this.index + cardsPerRow);
      mark(array[this.index]);
      this.scrollToCardRow(currentRow + 1, cardsPerRow);
      // Indicate that there are more card rows
      return true;
    }
    // Indicate that there are no more card rows
    return false;
  }

  scrollToCardRow(row, cardsPerRow) {
    const array = this.normalize();
    const targetCard = array[row * cardsPerRow];
    if (targetCard) {
      requestAnimationFrame(() => {
        targetCard.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      });
    }
  }

  reset() {
    this.index = 0;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ListView: ListView };
}

const Views = {
  Hosts: {
    view: new ListView(() => document.getElementById('host-grid').children),
    up: function() {
      // Nothing is above the row of cards but the header
      Navigation.change(Views.HostsNav);
      focusElement(Views.HostsNav.view.current());
    },
    down: function() {},
    left: function() {
      this.view.prev();
      focusElement(this.view.current());
    },
    right: function() {
      this.view.next();
      focusElement(this.view.current());
    },
    accept: function() {
      // The card itself handles the click: it opens the library, starts the pairing or the Add Host dialog
      clickElement(this.view.current());
    },
    back: function() {
      // Show the Exit Moonlight dialog and push the view
      exitAppDialog();
    },
    press: function() {
      const currentItem = resolveElement(this.view.current());
      // Check if the current item is not the Add Host card
      if (currentItem && currentItem.id !== 'addHostContainer') {
        // Click the Host Menu button of the card, show the Host Menu dialog and push the view
        const menuButton = currentItem.querySelector('.host-menu');
        focusElement(menuButton);
        clickElement(menuButton);
      }
    },
    menu: function() {
      // The Y button: the settings of the application
      clickElement('settingsBtn');
    },
    switch: function() {
      // Put the focus back on the card, for example when switching back from another view
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      // Disable the IP address text input field when entering the Hosts view
      handleIpTextFieldState(false);
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  HostsNav: {
    view: new ListView(() => {
      if (document.getElementById('updateAppBtn')) {
        return ['updateAppBtn', 'supportBtn', 'settingsBtn'];
      } else {
        return ['supportBtn', 'settingsBtn'];
      }
    }),
    up: function() {},
    down: function() {
      // Navigate to the Hosts view
      Navigation.change(Views.Hosts);
      // Set focus on the first navigation item in Hosts view when transitioning from HostsNav view
      focusElement(Views.Hosts.view.current());
    },
    left: function() {
      this.view.prev();
      focusElement(this.view.current());
    },
    right: function() {
      this.view.next();
      focusElement(this.view.current());
    },
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      // Navigate to the Hosts view
      Navigation.change(Views.Hosts);
      // Set focus on the first navigation item in Hosts view when transitioning from HostsNav view
      focusElement(Views.Hosts.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  AddHostDialog: {
    view: new ListView(() => {
      if (document.getElementById('ipAddressFieldModeSwitch').checked) {
        return ['ipAddressField1', 'ipAddressField2', 'ipAddressField3', 'ipAddressField4', 'continueAddHost', 'cancelAddHost'];
      } else {
        return ['ipAddressTextInput', 'continueAddHost', 'cancelAddHost'];
      }
    }),
    up: function() {
      const currentItem = elementId(this.view.current());
      const ipAddressFieldModeSwitch = document.getElementById('ipAddressFieldModeSwitch');
      // If the IP address field mode is enabled and the current item is an IP address numeric field
      if (ipAddressFieldModeSwitch.checked && currentItem.startsWith('ipAddressField')) {
        // Increase the value of the current IP address numeric field
        changeIpNumericFieldValue.call(this, 1);
      } else {
        // Go to the first item in the list (ipAddressTextInput)
        this.view.index = 0;
        focusElement(this.view.current());
      }
    },
    down: function() {
      const currentItem = elementId(this.view.current());
      const ipAddressFieldModeSwitch = document.getElementById('ipAddressFieldModeSwitch');
      // If the IP address field mode switch is enabled and the current item is an IP address numeric field
      if (ipAddressFieldModeSwitch.checked && currentItem.startsWith('ipAddressField')) {
        // Decrease the value of the current IP address numeric field
        changeIpNumericFieldValue.call(this, -1);
      } else {
        // Go to the second item in the list (continueAddHost)
        this.view.index = 1;
        focusElement(this.view.current());
      }
    },
    left: function() {
      this.view.prev();
      focusElement(this.view.current());
    },
    right: function() {
      this.view.next();
      focusElement(this.view.current());
    },
    accept: function() {
      const currentItem = elementId(this.view.current());
      // Check if the current item is the IP address text input field
      if (currentItem === 'ipAddressTextInput') {
        // Enable the text input field and set focus to it to open the virtual keyboard
        handleIpTextFieldState(true);
        return;
      } else {
        // Disable the text input field and set focus back to the hidden listener element
        handleIpTextFieldState(false);
        clickElement(this.view.current());
      }
    },
    back: function() {
      const currentItem = document.activeElement;
      // Check if the current item is the IP address text input field and it is not read-only
      if (currentItem && currentItem.id === 'ipAddressTextInput' && !currentItem.readOnly) {
        // Disable the text input field and set focus back to the hidden listener element
        handleIpTextFieldState(false);
        return;
      } else {
        // Otherwise, click the Cancel button to close the dialog
        resolveElement('cancelAddHost').click();
      }
    },
    press: function() {},
    switch: function() {
      const currentItem = resolveElement(this.view.current());
      // Check if the current item is either the Continue or Cancel button
      if (currentItem && (currentItem.id === 'continueAddHost' || currentItem.id === 'cancelAddHost')) {
        // Set focus only on the Continue or Cancel button element
        focusElement(currentItem);
      } else {
        // Remove focus from any other focused item element
        blurElement(currentItem);
      }
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  PairingDialog: {
    view: new ListView(() => [
      'cancelPairing'
    ]),
    up: function() {
      blurElement('cancelPairing');
    },
    down: function() {
      focusElement('cancelPairing');
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('cancelPairing').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  AutoWolDialog: {
    view: new ListView(() => [
      'autoWolCheckboxSwitch',
      'cancelAutoWol'
    ]),
    up: function() {
      const currentItem = elementId(this.view.current());
      if (currentItem === 'cancelAutoWol') {
        this.view.prev();
        focusElement(this.view.current());
      }
    },
    down: function() {
      const currentItem = elementId(this.view.current());
      if (currentItem === 'autoWolCheckboxSwitch') {
        this.view.next();
        focusElement(this.view.current());
      }
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('cancelAutoWol').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  HostMenuDialog: {
    view: new ListView(() => {
      const actions = ['refreshApps', 'wakeHost', 'deleteHost', 'viewDetails', 'closeHostMenu'];
      return actions.map(action => action === 'closeHostMenu' ? action : action + '-' + Views.HostMenuDialog.hostname);
    }),
    up: function() {
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      this.view.nextOption();
      focusElement(this.view.current());
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('closeHostMenu').click();
    },
    press: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  DeleteHostDialog: {
    view: new ListView(() => [
      'continueDeleteHost',
      'cancelDeleteHost'
    ]),
    up: function() {},
    down: function() {},
    left: function() {
      this.view.prev();
      focusElement('continueDeleteHost');
    },
    right: function() {
      this.view.next();
      focusElement('cancelDeleteHost');
    },
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('cancelDeleteHost').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  HostDetailsDialog: {
    view: new ListView(() => [
      'closeHostDetails'
    ]),
    up: function() {
      blurElement('closeHostDetails');
    },
    down: function() {
      focusElement('closeHostDetails');
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('closeHostDetails').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  MoonlightSupportDialog: {
    view: new ListView(() => [
      'closeAppSupport'
    ]),
    up: function() {
      blurElement('closeAppSupport');
    },
    down: function() {
      focusElement('closeAppSupport');
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('closeAppSupport').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  Settings: {
    view: new ListView(() => document.querySelector('.settings-categories').children),
    up: function() {
      // If there are more categories behind, then go to the previous category
      if (this.view.prevCategory()) {
        focusElement(this.view.current());
      } else {
        // If there are no more categories, navigate to the SettingsNav view
        Navigation.change(Views.SettingsNav);
        // Set focus on the first navigation item in SettingsNav view when transitioning from Settings view
        focusElement(Views.SettingsNav.view.current());
      }
    },
    down: function() {
      // If there are more categories after, then go to the next category
      if (this.view.nextCategory()) {
        focusElement(this.view.current());
      }
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('goBackBtn').click();
      // Navigate to the HostsNav view
      Navigation.change(Views.HostsNav);
      focusElement('settingsBtn');
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  SettingsNav: {
    view: new ListView(() => [
      'goBackBtn',
      'restoreDefaultsBtn'
    ]),
    up: function() {},
    down: function() {
      // Navigate to the Settings view
      Navigation.change(Views.Settings);
      // Set focus on the first navigation item in Settings view when transitioning from SettingsNav view
      focusElement(Views.Settings.view.current());
    },
    left: function() {
      this.view.prev();
      focusElement(this.view.current());
    },
    right: function() {
      this.view.next();
      focusElement(this.view.current());
    },
    accept: function() {
      const currentItem = resolveElement(this.view.current());
      if (currentItem && currentItem.id === 'goBackBtn') {
        clickElement(currentItem);
        // Navigate to the HostsNav view
        Navigation.change(Views.HostsNav);
        // Set focus to the "Settings" button after navigating to the HostsNav view
        focusElement('settingsBtn');
      } else {
        clickElement(this.view.current());
      }
    },
    back: function() {
      resolveElement('goBackBtn').click();
      // Navigate to the HostsNav view
      Navigation.change(Views.HostsNav);
      // Set focus to the "Settings" button after navigating to the HostsNav view
      focusElement('settingsBtn');
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  BasicSettings: {
    view: new ListView(() => [
      'selectResolution',
      'selectFramerate',
      'selectBitrate',
      'framePacingBtn'
    ]),
    up: function() {
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      this.view.nextOption();
      focusElement(this.view.current());
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      // Remove focus from the current element before changing the view
      blurElement(this.view.current());
      // Reset the current settings view before navigating to the next settings view
      resetSettingsView();
      // Navigate to the Settings view
      Navigation.change(Views.Settings);
      // Set focus on the category item in Settings view when transitioning from BasicSettings view
      focusElement(Views.Settings.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  SelectResolutionMenu: {
    isActive: () => isPopupMenuActive('videoResolutionMenu'),
    view: new ListView(() => 
      document.getElementById('videoResolutionMenu')
      .parentNode.children[3].children[1].children),
    up: function() {
      this.view.prevOption();
    },
    down: function() {
      this.view.nextOption();
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
      closeActiveVisibleMenu();
      setTimeout(() => focusElement('selectResolution'), 250);
    },
    back: function() {
      closePopupMenu('selectResolution');
      closeActiveVisibleMenu();
      focusElement('selectResolution');
    },
    press: function() {},
    switch: function() {},
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  SelectFramerateMenu: {
    isActive: () => isPopupMenuActive('videoFramerateMenu'),
    view: new ListView(() => 
      document.getElementById('videoFramerateMenu')
      .parentNode.children[3].children[1].children),
    up: function() {
      this.view.prevOption();
    },
    down: function() {
      this.view.nextOption();
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
      closeActiveVisibleMenu();
      setTimeout(() => focusElement('selectFramerate'), 250);
    },
    back: function() {
      closePopupMenu('selectFramerate');
      closeActiveVisibleMenu();
      focusElement('selectFramerate');
    },
    press: function() {},
    switch: function() {},
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  SelectBitrateMenu: {
    isActive: () => isPopupMenuActive('videoBitrateMenu'),
    view: new ListView(() => 
      document.getElementById('videoBitrateMenu')
      .parentNode.children[3].children[1].children),
    up: function() {},
    down: function() {},
    left: function() {
      bitrateSlider.stepDown();
      bitrateSlider.dispatchEvent(new Event('input'));
    },
    right: function() {
      bitrateSlider.stepUp();
      bitrateSlider.dispatchEvent(new Event('input'));
    },
    accept: function() {
      clickElement(this.view.current());
      closeActiveVisibleMenu();
      setTimeout(() => focusElement('selectBitrate'), 250);
    },
    back: function() {
      closePopupMenu('selectBitrate');
      closeActiveVisibleMenu();
      focusElement('selectBitrate');
    },
    press: function() {},
    switch: function() {},
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  InterfaceSettings: {
    view: new ListView(() => [
      'selectLanguage',
      'ipAddressFieldModeBtn'
    ]),
    up: function() {
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      this.view.nextOption();
      focusElement(this.view.current());
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      // Remove focus from the current element before changing the view
      blurElement(this.view.current());
      // Reset the current settings view before navigating to the next settings view
      resetSettingsView();
      // Navigate to the Settings view
      Navigation.change(Views.Settings);
      // Set focus on the category item in Settings view when transitioning from InterfaceSettings view
      focusElement(Views.Settings.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  SelectLanguageMenu: {
    isActive: () => isPopupMenuActive('languageMenu'),
    view: new ListView(() =>
      document.getElementById('languageMenu')
      .parentNode.children[3].children[1].children),
    up: function() {
      this.view.prevOption();
    },
    down: function() {
      this.view.nextOption();
    },
    left: function() {},
    right: function() {},
    accept: function() {
	  clickElement(this.view.current());
	  closeActiveVisibleMenu();
	  setTimeout(() => focusElement('selectLanguage'), 250);
    },
    back: function() {
      closePopupMenu('selectLanguage');
      closeActiveVisibleMenu();
      focusElement('selectLanguage');
    },
    press: function() {},
    switch: function() {},
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  HostSettings: {
    view: new ListView(() => [
      'sortAppsListBtn',
      'optimizeGamesBtn',
      'removeAllHostsBtn'
    ]),
    up: function() {
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      this.view.nextOption();
      focusElement(this.view.current());
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      // Remove focus from the current element before changing the view
      blurElement(this.view.current());
      // Reset the current settings view before navigating to the next settings view
      resetSettingsView();
      // Navigate to the Settings view
      Navigation.change(Views.Settings);
      // Set focus on the category item in Settings view when transitioning from HostSettings view
      focusElement(Views.Settings.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  InputSettings: {
    view: new ListView(() => [
      'rumbleFeedbackBtn',
      'mouseEmulationBtn',
      'flipABfaceButtonsBtn',
      'flipXYfaceButtonsBtn'
    ]),
    up: function() {
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      this.view.nextOption();
      focusElement(this.view.current());
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      // Remove focus from the current element before changing the view
      blurElement(this.view.current());
      // Reset the current settings view before navigating to the next settings view
      resetSettingsView();
      // Navigate to the Settings view
      Navigation.change(Views.Settings);
      // Set focus on the category item in Settings view when transitioning from InputSettings view
      focusElement(Views.Settings.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  AudioSettings: {
    view: new ListView(() => [
      'selectAudioBackend',
      isAudioOutputDisabled() ? null : 'selectAudio',
      // At most one of these settings is shown at a time, as each one belongs to a single backend,
      // and neither is shown when the audio output is disabled
      isAudioOutputDisabled() ? null : isWebAudioBackendSelected() ? 'selectAudioJitter' : 'audioSyncBtn',
      'playHostAudioBtn',
      isAudioOutputDisabled() ? null : 'decryptHostAudioBtn'
    ].filter(Boolean)),
    up: function() {
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      this.view.nextOption();
      focusElement(this.view.current());
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      // Remove focus from the current element before changing the view
      blurElement(this.view.current());
      // Reset the current settings view before navigating to the next settings view
      resetSettingsView();
      // Navigate to the Settings view
      Navigation.change(Views.Settings);
      // Set focus on the category item in Settings view when transitioning from AudioSettings view
      focusElement(Views.Settings.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  SelectAudioBackendMenu: {
    isActive: () => isPopupMenuActive('audioBackendMenu'),
    view: new ListView(() =>
      document.getElementById('audioBackendMenu')
      .parentNode.children[3].children[1].children),
    up: function() {
      this.view.prevOption();
    },
    down: function() {
      this.view.nextOption();
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
      closeActiveVisibleMenu();
      setTimeout(() => focusElement('selectAudioBackend'), 250);
    },
    back: function() {
      closePopupMenu('selectAudioBackend');
      closeActiveVisibleMenu();
      focusElement('selectAudioBackend');
    },
    press: function() {},
    switch: function() {},
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  SelectAudioMenu: {
    isActive: () => isPopupMenuActive('audioConfigMenu'),
    view: new ListView(() => 
      document.getElementById('audioConfigMenu')
      .parentNode.children[3].children[1].children),
    up: function() {
      this.view.prevOption();
    },
    down: function() {
      this.view.nextOption();
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
      closeActiveVisibleMenu();
      setTimeout(() => focusElement('selectAudio'), 250);
    },
    back: function() {
      closePopupMenu('selectAudio');
      closeActiveVisibleMenu();
      focusElement('selectAudio');
    },
    press: function() {},
    switch: function() {},
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  SelectAudioJitterMenu: {
    isActive: () => isPopupMenuActive('audioJitterMenu'),
    view: new ListView(() =>
      document.getElementById('audioJitterMenu')
      .parentNode.children[3].children[1].children),
    up: function() {},
    down: function() {},
    left: function() {
      jitterSlider.stepDown();
      jitterSlider.dispatchEvent(new Event('input'));
    },
    right: function() {
      jitterSlider.stepUp();
      jitterSlider.dispatchEvent(new Event('input'));
    },
    accept: function() {
      clickElement(this.view.current());
      closeActiveVisibleMenu();
      setTimeout(() => focusElement('selectAudioJitter'), 250);
    },
    back: function() {
      closePopupMenu('selectAudioJitter');
      closeActiveVisibleMenu();
      focusElement('selectAudioJitter');
    },
    press: function() {},
    switch: function() {},
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  VideoSettings: {
    view: new ListView(() => [
      'selectCodec',
      'hdrModeBtn',
      'fullRangeBtn',
      'gameModeBtn'
    ]),
    up: function() {
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      this.view.nextOption();
      focusElement(this.view.current());
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      // Remove focus from the current element before changing the view
      blurElement(this.view.current());
      // Reset the current settings view before navigating to the next settings view
      resetSettingsView();
      // Navigate to the Settings view
      Navigation.change(Views.Settings);
      // Set focus on the category item in Settings view when transitioning from VideoSettings view
      focusElement(Views.Settings.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  SelectCodecMenu: {
    isActive: () => isPopupMenuActive('videoCodecMenu'),
    view: new ListView(() => 
      document.getElementById('videoCodecMenu')
      .parentNode.children[3].children[1].children),
    up: function() {
      this.view.prevOption();
    },
    down: function() {
      this.view.nextOption();
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
      closeActiveVisibleMenu();
      setTimeout(() => focusElement('selectCodec'), 250);
    },
    back: function() {
      closePopupMenu('selectCodec');
      closeActiveVisibleMenu();
      focusElement('selectCodec');
    },
    press: function() {},
    switch: function() {},
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  AdvancedSettings: {
    view: new ListView(() => [
      'unlockAllFpsBtn',
      'optimizeBitrateBtn',
      'disableWarningsBtn',
      'performanceStatsBtn',
      'speculativeRfiBtn'
    ]),
    up: function() {
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      this.view.nextOption();
      focusElement(this.view.current());
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      // Remove focus from the current element before changing the view
      blurElement(this.view.current());
      // Reset the current settings view before navigating to the next settings view
      resetSettingsView();
      // Navigate to the Settings view
      Navigation.change(Views.Settings);
      // Set focus on the category item in Settings view when transitioning from AdvancedSettings view
      focusElement(Views.Settings.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  DiagnosticSettings: {
    // The switch that saves the logs is the first row, and the rest is there only while the logs are saved
    view: new ListView(() => {
      const options = document.getElementById('diagnosticOptions');
      if (options && options.classList.contains('hide-container')) {
        return ['diagnosticLogsEnabledBtn'];
      }
      return [
        'diagnosticLogsEnabledBtn',
        'diagnosticHost',
        'diagnosticPort',
        'sendDiagnosticLogsBtn',
        'clearDiagnosticLogsBtn',
        'diagnosticCurrentSessionBtn',
        'diagnosticLogViewport'
      ];
    }),
    up: function() {
      if (this.view.current() === 'diagnosticLogViewport') {
        const viewport = resolveElement('diagnosticLogViewport');
        if (viewport.scrollTop > 0) {
          viewport.scrollTop = Math.max(0, viewport.scrollTop - 160);
          return;
        }
      }
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      if (this.view.current() === 'diagnosticLogViewport') {
        const viewport = resolveElement('diagnosticLogViewport');
        if (viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight) {
          viewport.scrollTop += 160;
          return;
        }
      }
      this.view.nextOption();
      focusElement(this.view.current());
    },
    // The two buttons of the session row are one control: left is the current session, right is the previous one
    left: function() {
      if (this.view.current() === 'diagnosticCurrentSessionBtn') {
        clickElement('diagnosticCurrentSessionBtn');
      }
    },
    right: function() {
      if (this.view.current() === 'diagnosticCurrentSessionBtn') {
        clickElement('diagnosticPreviousSessionBtn');
      }
    },
    accept: function() {
      const current = this.view.current();
      if (current === 'diagnosticHost' || current === 'diagnosticPort') {
        handleDiagnosticFieldState(current, true);
        return;
      }
      if (current === 'diagnosticCurrentSessionBtn') {
        // A switches to the session that is not shown
        const showsCurrent = resolveElement('diagnosticCurrentSessionBtn').classList.contains('selected');
        clickElement(showsCurrent ? 'diagnosticPreviousSessionBtn' : 'diagnosticCurrentSessionBtn');
        return;
      }
      clickElement(current);
    },
    back: function() {
      // B first ends the typing in a field
      const typing = document.activeElement;
      if (typing && (typing.id === 'diagnosticHost' || typing.id === 'diagnosticPort') && !typing.readOnly) {
        handleDiagnosticFieldState(typing, false);
        return;
      }
      blurElement(this.view.current());
      resetSettingsView();
      Navigation.change(Views.Settings);
      focusElement(Views.Settings.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  AboutSettings: {
    view: new ListView(() => [
      'systemInfoBtn',
      'navigationGuideBtn',
      'checkUpdatesBtn',
      'restartAppBtn'
    ]),
    up: function() {
      this.view.prevOption();
      focusElement(this.view.current());
    },
    down: function() {
      this.view.nextOption();
      focusElement(this.view.current());
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      // Remove focus from the current element before changing the view
      blurElement(this.view.current());
      // Reset the current settings view before navigating to the next settings view
      resetSettingsView();
      // Navigate to the Settings view
      Navigation.change(Views.Settings);
      // Set focus on the category item in Settings view when transitioning from AboutSettings view
      focusElement(Views.Settings.view.current());
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  NavigationGuideDialog: {
    view: new ListView(() => [
      'closeNavGuide'
    ]),
    up: function() {
      blurElement('closeNavGuide');
    },
    down: function() {
      focusElement('closeNavGuide');
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('closeNavGuide').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  UpdateMoonlightDialog: {
    view: new ListView(() => [
      'closeUpdateApp'
    ]),
    up: function() {
      blurElement('closeUpdateApp');
    },
    down: function() {
      focusElement('closeUpdateApp');
    },
    left: function() {},
    right: function() {},
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('closeUpdateApp').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  RestoreDefaultsDialog: {
    view: new ListView(() => [
      'continueRestoreDefaults',
      'cancelRestoreDefaults'
    ]),
    up: function() {},
    down: function() {},
    left: function() {
      this.view.prev();
      focusElement('continueRestoreDefaults');
    },
    right: function() {
      this.view.next();
      focusElement('cancelRestoreDefaults');
    },
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('cancelRestoreDefaults').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  Apps: {
    view: new ListView(() => document.getElementById('game-grid').children),
    up: function() {
      // Nothing is above the row of tiles but the header
      Navigation.change(Views.AppsNav);
      // Set focus on the first navigation item in AppsNav view when transitioning from Apps view
      focusElement(Views.AppsNav.view.current());
    },
    down: function() {},
    left: function() {
      this.view.prev();
      focusTile(this.view.current(), 'smooth');
    },
    right: function() {
      this.view.next();
      focusTile(this.view.current(), 'smooth');
    },
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('goBackBtn').click();
    },
    press: function() {},
    switch: function() {
      // Bring the current tile to the middle of the row, for example when coming back from the stream
      centerInRow(this.view.current(), 'auto');
    },
    enter: function() {
      mark(this.view.current());
      // The list opens on the tile that is current, for example the app that runs
      centerInRow(this.view.current(), 'auto');
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  AppsNav: {
    view: new ListView(() => [
      'goBackBtn',
      'quitRunningAppBtn'
    ]),
    up: function() {},
    down: function() {
      // Navigate to the Apps view
      Navigation.change(Views.Apps);
      // Set focus on the current tile in Apps view when transitioning from AppsNav view
      focusTile(Views.Apps.view.current(), 'smooth');
    },
    left: function() {
      this.view.prev();
      focusElement(this.view.current());
    },
    right: function() {
      this.view.next();
      focusElement(this.view.current());
    },
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('goBackBtn').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
    },
    leave: function() {
      unmark(this.view.current());
    },
  },
  QuitAppDialog: {
    view: new ListView(() => [
      'continueQuitApp',
      'cancelQuitApp'
    ]),
    up: function() {},
    down: function() {},
    left: function() {
      this.view.prev();
      focusElement('continueQuitApp');
    },
    right: function() {
      this.view.next();
      focusElement('cancelQuitApp');
    },
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('cancelQuitApp').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  WarningDialog: {
    view: new ListView(() => {
      // Dynamically return the visible buttons
      var buttons = [];
      if ($('#continueWarning').is(':visible')) {
        buttons.push('continueWarning');
      }
      if ($('#closeWarning').is(':visible')) {
        buttons.push('closeWarning');
      }
      return buttons;
    }),
    up: function() {},
    down: function() {},
    left: function() {
      if ($('#continueWarning').is(':visible') && $('#closeWarning').is(':visible')) {
        this.view.prev();
        focusElement(this.view.current());
      }
    },
    right: function() {
      if ($('#continueWarning').is(':visible') && $('#closeWarning').is(':visible')) {
        this.view.next();
        focusElement(this.view.current());
      }
    },
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('closeWarning').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      // Default to Continue button (index 0) when both buttons are visible
      // Otherwise default to the only visible Close button (index 0)
      this.view.index = 0;
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  RestartMoonlightDialog: {
    view: new ListView(() => [
      'continueRestartApp',
      'cancelRestartApp'
    ]),
    up: function() {},
    down: function() {},
    left: function() {
      this.view.prev();
      focusElement('continueRestartApp');
    },
    right: function() {
      this.view.next();
      focusElement('cancelRestartApp');
    },
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('cancelRestartApp').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
  ExitMoonlightDialog: {
    view: new ListView(() => [
      'continueExitApp',
      'cancelExitApp'
    ]),
    up: function() {},
    down: function() {},
    left: function() {
      this.view.prev();
      focusElement('continueExitApp');
    },
    right: function() {
      this.view.next();
      focusElement('cancelExitApp');
    },
    accept: function() {
      clickElement(this.view.current());
    },
    back: function() {
      resolveElement('cancelExitApp').click();
    },
    press: function() {},
    switch: function() {
      focusElement(this.view.current());
    },
    enter: function() {
      mark(this.view.current());
      setTimeout(() => focusElement(this.view.current()), 100);
    },
    leave: function() {
      unmark(this.view.current());
      setTimeout(() => blurElement(this.view.current()), 100);
    },
  },
};

const Navigation = (function() {
  let hasFocus = false;

  function loseFocus() {
    if (hasFocus) {
      hasFocus = false;
      Stack.get().leave();
    }
  }

  function focus() {
    if (!hasFocus) {
      hasFocus = true;
      Stack.get().enter();
    }
  }

  function runOp(name) {
    return () => {
      if (!State.isRunning()) {
        return;
      }

      if (!hasFocus) {
        focus();
        return;
      }

      const view = Stack.get();
      if (view[name]) {
        view[name]();
      }
    };
  }

  const Stack = (function() {
    const viewStack = [];

    function get() {
      return viewStack[viewStack.length - 1];
    }

    function push(view, hostname) {
      if (get()) {
        get().leave();
      }
      if (hostname !== undefined) {
        view.hostname = hostname;
      }
      viewStack.push(view);
      get().enter();
    }

    function change(view) {
      get().leave();
      viewStack[viewStack.length - 1] = view;
      get().enter();
    }

    function pop() {
      if (viewStack.length > 1) {
        get().leave();
        viewStack.pop();
        get().enter();
      }
    }

    return {
      get,
      push,
      change,
      pop
    };
  })();

  const State = (function() {
    let running = false;

    function start() {
      if (!running) {
        running = true;
        window.addEventListener('mousemove', loseFocus);
      }
    }

    function stop() {
      if (running) {
        running = false;
        window.removeEventListener('mousemove', loseFocus);
      }
    }

    function isRunning() {
      return running;
    }

    return {
      start,
      stop,
      isRunning
    };
  })();

  return {
    up: runOp('up'),
    down: runOp('down'),
    left: runOp('left'),
    right: runOp('right'),
    accept: runOp('accept'),
    back: runOp('back'),
    press: runOp('press'),
    menu: runOp('menu'),
    switch: runOp('switch'),
    push: Stack.push,
    change: Stack.change,
    pop: Stack.pop,
    start: State.start,
    stop: State.stop,
  };
})();
