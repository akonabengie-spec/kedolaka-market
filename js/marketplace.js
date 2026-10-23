(function () {
  'use strict';

  let currentUser = null;
  let sessionError = null;
  let cartItems = [];
  let cartLoadRequest = 0;
  let checkoutContactRequest = 0;
  let checkoutLocalContactsReady = true;
  let catalogOffset = 0;
  let catalogTimer = null;
  let freightQuoteRequest = 0;
  let freightQuoteReady = false;
  let paymentMethodReady = false;
  let installPromptEvent = null;
  let installButton = null;
  const deliveryProvinceStorageKey = 'kedolaka-delivery-province';
  const colorThemeStorageKey = 'kedolaka-color-theme';
  const catalogLimit = 20;
  let currentColorTheme = 'light';
  const pngProvinces = [
    'NCD', 'Morobe', 'Western Highlands', 'East New Britain', 'Eastern Highlands', 'Madang',
    'Milne Bay', 'East Sepik', 'West Sepik', 'Bougainville', 'Manus', 'New Ireland',
    'West New Britain', 'Central', 'Gulf', 'Oro', 'Western', 'Southern Highlands',
    'Enga', 'Hela', 'Jiwaka', 'Chimbu'
  ];
  const vendorPaymentChoices = [
    { id: 'bank_transfer', label: 'Bank transfer' },
    { id: 'mobile_wallet', label: 'Mobile wallet' },
    { id: 'cash_on_delivery', label: 'Cash on delivery' },
    { id: 'in_person', label: 'Pay in person' }
  ];

  try {
    const savedTheme = window.localStorage.getItem(colorThemeStorageKey);
    currentColorTheme = savedTheme === 'dark' || savedTheme === 'light'
      ? savedTheme
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (error) {
    console.error('Could not load the saved color theme:', error);
    currentColorTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = currentColorTheme;
  const browserThemeColor = document.querySelector('meta[name="theme-color"]');
  if (browserThemeColor) browserThemeColor.content = currentColorTheme === 'dark' ? '#111827' : '#123f35';

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installPromptEvent = event;
    if (installButton) installButton.hidden = false;
  });
  window.addEventListener('appinstalled', function () {
    installPromptEvent = null;
    if (installButton) installButton.hidden = true;
  });

  function setupPwa() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(function (error) {
      console.error('Could not enable offline app support:', error);
    });
  }

  function isIosBrowser() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function addInstallButton(navigation) {
    if (!navigation || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
    installButton = document.createElement('button');
    installButton.className = 'nav-button';
    installButton.type = 'button';
    installButton.textContent = 'Install app';
    installButton.hidden = !installPromptEvent && !isIosBrowser();
    installButton.addEventListener('click', async function () {
      if (isIosBrowser() && !installPromptEvent) {
        window.alert('To install KEDOLAKA MARKET, tap Share in Safari, then choose Add to Home Screen.');
        return;
      }
      if (!installPromptEvent) return;
      installButton.disabled = true;
      try {
        await installPromptEvent.prompt();
        await installPromptEvent.userChoice;
        installPromptEvent = null;
        installButton.hidden = true;
      } catch (error) {
        console.error('Could not open the app installation prompt:', error);
      } finally {
        installButton.disabled = false;
      }
    });
    navigation.appendChild(installButton);
  }

  function parseBankTransferInstructions(value) {
    const details = {
      bsp: { accountName: '', accountNumber: '' },
      kina: { accountName: '', accountNumber: '' },
      note: ''
    };
    if (typeof value !== 'string') return details;
    const lines = value.split(/\r?\n/);

    if (!lines.some(function (line) { return line === 'BSP Bank' || line === 'Kina Bank'; })) {
      details.note = value;
      return details;
    }
    let bank = null;
    lines.forEach(function (line) {
      if (line === 'BSP Bank') {
        bank = details.bsp;
      } else if (line === 'Kina Bank') {
        bank = details.kina;
      } else if (line.startsWith('Account name: ')) {
        if (bank) bank.accountName = line.slice('Account name: '.length);
      } else if (line.startsWith('Account number: ')) {
        if (bank) bank.accountNumber = line.slice('Account number: '.length);
      } else if (line.startsWith('Note: ')) {
        details.note = line.slice('Note: '.length);
      }
    });
    return details;
  }

  function updateShippingProviderAvailability() {
    const providers = Array.from(document.querySelectorAll('input[name="carrierMethod"]'));
    if (!providers.length) return;
    const destination = document.getElementById('deliveryProvince');
    const origins = new Set(cartItems.map(function (item) { return item.province; }));
    const localRoute = Boolean(destination && destination.value && origins.size &&
      Array.from(origins).every(function (origin) { return origin === destination.value; }));
    const interprovinceRoute = Boolean(destination && destination.value && origins.size &&
      Array.from(origins).every(function (origin) { return origin !== destination.value; }));
    providers.forEach(function (provider) {
      const isPickup = provider.value === 'Pickup';
      const compatibleRoute = (isPickup || provider.value === 'PMV')
        ? localRoute
        : ['Ship', 'AirNiugini'].includes(provider.value) && interprovinceRoute;
      const supported = cartItems.length > 0 && compatibleRoute && cartItems.every(function (item) {
        const type = item.delivery_type || 'both';
        const contactReady = provider.value !== 'PMV' || item.local_delivery_available === true;
        return contactReady && (type === 'both' || (isPickup ? type === 'pickup' : type === 'delivery'));
      });
      provider.disabled = !supported;
      if (!supported && provider.checked) provider.checked = false;
    });
  }

  function updateCheckoutAvailability() {
    const button = document.getElementById('placeOrderButton');
    if (!button) return;
    const address = document.getElementById('deliveryAddress');
    const province = document.getElementById('deliveryProvince');
    const phone = document.getElementById('deliveryPhone');
    const provider = document.querySelector('input[name="carrierMethod"]:checked');
    const shippingPayer = document.querySelector('input[name="shippingPayer"]:checked');
    const paymentGroups = Array.from(document.querySelectorAll('#paymentMethods fieldset'));
    const hasAllPayments = paymentGroups.length > 0 && paymentGroups.every(function (group) {
      return Boolean(group.querySelector('input[type="radio"]:checked'));
    });
    const deliveryDetailsReady = Boolean(address && province && phone &&
      address.value.trim().length >= 5 && address.value.trim().length <= 500 &&
      address.checkValidity() && province.value && province.checkValidity() &&
      phone.value.trim() && phone.checkValidity());
    const needsLocalContact = Boolean(provider && provider.value === 'PMV' && province && cartItems.some(function (item) {
      return item.province === province.value && item.delivery_type !== 'pickup';
    }));
    button.disabled = !deliveryDetailsReady || !provider || provider.disabled ||
      !shippingPayer || !freightQuoteReady || !paymentMethodReady || !hasAllPayments ||
      (needsLocalContact && !checkoutLocalContactsReady) ||
      !cartItems.length || cartItems.some(function (item) { return !item.available; });
  }

  function parseMobileWalletInstructions(value) {
    const details = { provider: '', accountName: '', number: '', note: '' };
    if (typeof value !== 'string') return details;
    const lines = value.split(/\r?\n/);
    if (!lines.some(function (line) {
      return line.startsWith('Provider: ') || line.startsWith('Account name: ') ||
        line.startsWith('Wallet number: ') || line.startsWith('Note: ');
    })) {
      details.note = value;
      return details;
    }
    lines.forEach(function (line) {
      if (line.startsWith('Provider: ')) details.provider = line.slice('Provider: '.length);
      else if (line.startsWith('Account name: ')) details.accountName = line.slice('Account name: '.length);
      else if (line.startsWith('Wallet number: ')) details.number = line.slice('Wallet number: '.length);
      else if (line.startsWith('Note: ')) details.note = line.slice('Note: '.length);
    });
    return details;
  }

  function appendTextField(container, labelText, name, value, options) {
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = options && options.type || 'text';
    input.name = name;
    input.maxLength = options && options.maxLength || 120;
    input.autocomplete = 'off';
    input.value = value || '';
    if (options && options.placeholder) input.placeholder = options.placeholder;
    if (options && options.pattern) input.pattern = options.pattern;
    label.appendChild(input);
    container.appendChild(label);
  }

  function appendBankAccountFields(container, bankId, bankLabel, account) {
    const section = document.createElement('div');
    section.className = 'vendor-bank-account';
    const heading = document.createElement('h4');
    heading.textContent = bankLabel;
    section.appendChild(heading);
    appendTextField(section, 'Account name', 'bank-' + bankId + '-account-name', account.accountName);
    appendTextField(section, 'Account number', 'bank-' + bankId + '-account-number', account.accountNumber, { maxLength: 60 });
    container.appendChild(section);
  }

  function renderVendorPaymentSetup(container, methods) {
    if (!container) return;
    const current = new Map((Array.isArray(methods) ? methods : []).map(function (method) {
      return [method.id, method];
    }));
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'vendor-payment-options';
    const legend = document.createElement('legend');
    legend.textContent = 'Payment methods customers can use (select all that apply)';
    fieldset.appendChild(legend);
    const guidance = document.createElement('p');
    guidance.textContent = 'Enter separate payment details for each selected method. Customers choose one method at checkout.';
    fieldset.appendChild(guidance);
    vendorPaymentChoices.forEach(function (choice) {
      const row = document.createElement('div');
      row.className = 'vendor-payment-option';
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'vendorPaymentMethod';
      checkbox.value = choice.id;
      checkbox.checked = current.has(choice.id);
      const labelText = document.createElement('span');
      labelText.textContent = choice.label;
      label.append(checkbox, labelText);
      const details = document.createElement('div');
      details.className = 'vendor-payment-instructions';
      const methodDetails = current.get(choice.id) || {};
      if (choice.id === 'bank_transfer') {
        const bankDetails = parseBankTransferInstructions(methodDetails.instructions || '');
        const prompt = document.createElement('p');
        prompt.textContent = 'Add details for at least one bank. If you provide details for both, customers can choose either BSP or Kina Bank.';
        details.appendChild(prompt);
        appendBankAccountFields(details, 'bsp', 'BSP Bank', bankDetails.bsp);
        appendBankAccountFields(details, 'kina', 'Kina Bank', bankDetails.kina);
        const noteLabel = document.createElement('label');
        noteLabel.textContent = 'Bank transfer note (optional)';
        const note = document.createElement('textarea');
        note.name = 'bank-transfer-note';
        note.maxLength = 300;
        note.rows = 3;
        note.placeholder = 'Add any extra payment note for customers.';
        note.value = bankDetails.note;
        noteLabel.appendChild(note);
        details.appendChild(noteLabel);
      } else if (choice.id === 'mobile_wallet') {
        const wallet = parseMobileWalletInstructions(methodDetails.instructions || '');
        const fields = document.createElement('div');
        fields.className = 'vendor-mobile-wallet';
        appendTextField(fields, 'Mobile wallet provider', 'mobile-wallet-provider', wallet.provider, {
          placeholder: 'e.g. Digicel MyCash or bmobile wallet'
        });
        appendTextField(fields, 'Account name', 'mobile-wallet-account-name', wallet.accountName);
        appendTextField(fields, 'Mobile wallet number', 'mobile-wallet-number', wallet.number, {
          maxLength: 60,
          type: 'tel',
          placeholder: 'Enter the number customers should pay'
        });
        details.appendChild(fields);
        const noteLabel = document.createElement('label');
        noteLabel.textContent = 'Mobile wallet note (optional)';
        const note = document.createElement('textarea');
        note.name = 'mobile-wallet-note';
        note.maxLength = 300;
        note.rows = 3;
        note.placeholder = 'Add any extra payment note for customers.';
        note.value = wallet.note;
        noteLabel.appendChild(note);
        details.appendChild(noteLabel);
      } else {
        const instructionLabel = document.createElement('label');
        instructionLabel.textContent = choice.label + ' payment details and instructions';
        const textarea = document.createElement('textarea');
        textarea.name = 'instructions-' + choice.id;
        textarea.minLength = 5;
        textarea.maxLength = 1000;
        textarea.rows = 3;
        textarea.placeholder = 'Enter customer-facing details (such as a mobile wallet number) and payment steps. Do not enter passwords or security credentials.';
        textarea.value = methodDetails.instructions || '';
        instructionLabel.appendChild(textarea);
        details.appendChild(instructionLabel);
      }
      if (choice.id === 'bank_transfer' || choice.id === 'mobile_wallet') {
        const contactFields = document.createElement('div');
        contactFields.className = 'vendor-reference-contact-fields';
        const contactOptions = {
          type: 'tel', maxLength: 20, pattern: '\\+675[78][0-9]{7}', placeholder: '+6757XXXXXXX'
        };
        appendTextField(contactFields, 'Phone for payment references', 'reference-phone-' + choice.id, methodDetails.referencePhone, contactOptions);
        appendTextField(contactFields, 'WhatsApp for payment references', 'reference-whatsapp-' + choice.id, methodDetails.referenceWhatsapp, contactOptions);
        details.appendChild(contactFields);
      }
      details.querySelectorAll('input, textarea').forEach(function (input) {
        input.disabled = !checkbox.checked;
      });
      checkbox.addEventListener('change', function () {
        details.querySelectorAll('input, textarea').forEach(function (input) {
          input.disabled = !checkbox.checked;
        });
      });
      row.append(label, details);
      fieldset.appendChild(row);
    });
    container.replaceChildren(fieldset);
  }

  function getVendorPaymentSetupError(container) {
    if (!container) return 'Payment settings are unavailable.';
    const selected = container.querySelectorAll('input[name="vendorPaymentMethod"]:checked');
    if (!selected.length) return 'Choose at least one payment method for your business.';
    for (const checkbox of selected) {
      if (checkbox.value === 'bank_transfer') {
        const bspName = container.querySelector('[name="bank-bsp-account-name"]').value.trim();
        const bspNumber = container.querySelector('[name="bank-bsp-account-number"]').value.trim();
        const kinaName = container.querySelector('[name="bank-kina-account-name"]').value.trim();
        const kinaNumber = container.querySelector('[name="bank-kina-account-number"]').value.trim();
        if (Boolean(bspName) !== Boolean(bspNumber) || Boolean(kinaName) !== Boolean(kinaNumber)) {
          return 'For each bank, enter both the account name and account number, or leave both blank.';
        }
        if ((!bspName || !bspNumber) && (!kinaName || !kinaNumber)) {
          return 'Enter an account name and account number for BSP Bank, Kina Bank, or both.';
        }
      } else if (checkbox.value === 'mobile_wallet') {
        const provider = container.querySelector('[name="mobile-wallet-provider"]').value.trim();
        const accountName = container.querySelector('[name="mobile-wallet-account-name"]').value.trim();
        const number = container.querySelector('[name="mobile-wallet-number"]').value.trim();
        if (!provider || !accountName || !number) {
          return 'Enter the mobile wallet provider, account name, and mobile wallet number.';
        }
      } else {
        const textarea = container.querySelector('textarea[name="instructions-' + checkbox.value + '"]');
        if (!textarea || textarea.value.trim().length < 5) {
          return 'Enter at least 5 characters of customer-facing details for ' +
            (vendorPaymentChoices.find(function (choice) { return choice.id === checkbox.value; }) || {}).label + '.';
        }
      }
      if (checkbox.value === 'bank_transfer' || checkbox.value === 'mobile_wallet') {
        const phone = container.querySelector('[name="reference-phone-' + checkbox.value + '"]').value.trim();
        const whatsapp = container.querySelector('[name="reference-whatsapp-' + checkbox.value + '"]').value.trim();
        const validPhone = /^\+675[78]\d{7}$/.test(phone);
        const validWhatsapp = /^\+675[78]\d{7}$/.test(whatsapp);
        if (!phone && !whatsapp) return 'Add a phone number or WhatsApp number so buyers can send payment references.';
        if ((phone && !validPhone) || (whatsapp && !validWhatsapp)) return 'Payment reference contacts must use a valid PNG number: +675 followed by 7 or 8 and seven digits.';
      }
    }
    return '';
  }

  function readVendorPaymentSetup(container) {
    const methods = [];
    if (!container) return methods;
    container.querySelectorAll('input[name="vendorPaymentMethod"]:checked').forEach(function (checkbox) {
      if (checkbox.value === 'bank_transfer') {
        const bspName = container.querySelector('[name="bank-bsp-account-name"]').value.trim();
        const bspNumber = container.querySelector('[name="bank-bsp-account-number"]').value.trim();
        const kinaName = container.querySelector('[name="bank-kina-account-name"]').value.trim();
        const kinaNumber = container.querySelector('[name="bank-kina-account-number"]').value.trim();
        const note = container.querySelector('[name="bank-transfer-note"]').value.trim();
        const instructions = [];
        if (bspName && bspNumber) instructions.push('BSP Bank\nAccount name: ' + bspName + '\nAccount number: ' + bspNumber);
        if (kinaName && kinaNumber) instructions.push('Kina Bank\nAccount name: ' + kinaName + '\nAccount number: ' + kinaNumber);
        if (note) instructions.push('Note: ' + note);
        methods.push({
          id: checkbox.value, instructions: instructions.join('\n\n'),
          referencePhone: container.querySelector('[name="reference-phone-' + checkbox.value + '"]').value.trim(),
          referenceWhatsapp: container.querySelector('[name="reference-whatsapp-' + checkbox.value + '"]').value.trim()
        });
      } else if (checkbox.value === 'mobile_wallet') {
        const provider = container.querySelector('[name="mobile-wallet-provider"]').value.trim();
        const accountName = container.querySelector('[name="mobile-wallet-account-name"]').value.trim();
        const number = container.querySelector('[name="mobile-wallet-number"]').value.trim();
        const note = container.querySelector('[name="mobile-wallet-note"]').value.trim();
        const instructions = [
          'Provider: ' + provider,
          'Account name: ' + accountName,
          'Wallet number: ' + number
        ];
        if (note) instructions.push('Note: ' + note);
        methods.push({
          id: checkbox.value, instructions: instructions.join('\n'),
          referencePhone: container.querySelector('[name="reference-phone-' + checkbox.value + '"]').value.trim(),
          referenceWhatsapp: container.querySelector('[name="reference-whatsapp-' + checkbox.value + '"]').value.trim()
        });
      } else {
        const textarea = container.querySelector('textarea[name="instructions-' + checkbox.value + '"]');
        methods.push({ id: checkbox.value, instructions: textarea ? textarea.value.trim() : '' });
      }
    });
    return methods;
  }

  function text(value) {
    return String(value == null ? '' : value);
  }

  async function api(url, options) {
    const request = options || {};
    const headers = Object.assign({}, request.headers || {});
    if (request.body && !headers['Content-Type'] && !(request.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, Object.assign({}, request, {
      credentials: 'same-origin',
      headers: headers
    }));
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      const failure = new Error(response.ok ? 'The server returned an invalid response.' : 'The request could not be completed.');
      failure.status = response.status;
      throw failure;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const failure = new Error('The server returned an invalid response.');
      failure.status = response.status;
      throw failure;
    }
    if (!response.ok) {
      const failure = new Error(payload.message || 'The request could not be completed.');
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  function showMessage(node, message, kind) {
    if (!node) return;
    node.textContent = message;
    node.className = 'message' + (kind ? ' ' + kind : '');
  }

  function provinceLabel(value) {
    return value === 'NCD' ? 'National Capital District' : text(value);
  }

  function deliveryTypeLabel(value) {
    return { delivery: 'Delivery', pickup: 'Pickup', both: 'Delivery or pickup' }[value] || 'Delivery or pickup';
  }

  function paymentMethodLabel(value) {
    return ({
      manual_bank_transfer: 'Bank transfer',
      mobile_wallet: 'Mobile wallet',
      cash_on_delivery: 'Cash on delivery',
      in_person: 'Pay in person'
    })[value] || text(value);
  }

  function appendPaymentReferenceContacts(parent, phone, whatsapp) {
    if (!phone && !whatsapp) return;
    const contact = document.createElement('span');
    contact.className = 'payment-reference-contact';
    contact.appendChild(document.createTextNode('Send your payment reference to the vendor: '));
    if (phone) {
      const phoneLink = document.createElement('a');
      phoneLink.href = 'tel:' + phone;
      phoneLink.textContent = 'Call or text ' + phone;
      contact.appendChild(phoneLink);
    }
    if (phone && whatsapp) contact.appendChild(document.createTextNode(' · '));
    if (whatsapp) {
      const whatsappLink = document.createElement('a');
      whatsappLink.href = 'https://wa.me/' + whatsapp.replace(/\D/g, '').replace(/^0+/, '');
      whatsappLink.target = '_blank';
      whatsappLink.rel = 'noopener noreferrer';
      whatsappLink.textContent = 'WhatsApp ' + whatsapp;
      contact.appendChild(whatsappLink);
    }
    parent.appendChild(contact);
  }

  function appendDeliveryContact(parent, contact) {
    if (!contact) return;
    const details = document.createElement('small');
    details.className = 'order-delivery-contact';
    details.textContent = `Driver/skipper: ${contact.name} · ${contact.transport} · Route: ${contact.route} · `;
    const phoneLink = document.createElement('a');
    phoneLink.href = 'tel:' + contact.phone;
    phoneLink.textContent = contact.phone;
    details.appendChild(phoneLink);
    parent.appendChild(details);
  }

  function updateDeliveryDisplay(value) {
    document.querySelectorAll('[data-deliver-to]').forEach(function (node) {
      node.textContent = value ? provinceLabel(value) : 'Not selected';
    });
  }

  function getSavedDeliveryProvince() {
    let value;
    try {
      value = window.localStorage.getItem(deliveryProvinceStorageKey);
    } catch (error) {
      console.warn('Could not read the saved delivery province.');
      return '';
    }
    return typeof value === 'string' ? value.trim() : '';
  }

  function saveDeliveryProvince(value) {
    try {
      if (value) window.localStorage.setItem(deliveryProvinceStorageKey, value);
      else window.localStorage.removeItem(deliveryProvinceStorageKey);
    } catch (error) {
      console.warn('Could not save the delivery province for this browser.');
    }
    updateDeliveryDisplay(value);
  }

  function setupBreadcrumbs() {
    document.querySelectorAll('nav[aria-label="Breadcrumb"]').forEach(function (navigation) {
      const parts = [];
      Array.from(navigation.childNodes).forEach(function (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          node.textContent.split('/').forEach(function (part) {
            const label = part.trim();
            if (label) parts.push(document.createTextNode(label));
          });
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.getAttribute('aria-hidden') === 'true') return;
          if (node.matches('span') && node.textContent.trim() === '/') return;
          parts.push(node);
        }
      });
      if (!parts.length) return;

      const list = document.createElement('ol');
      list.className = 'breadcrumb-list';
      parts.forEach(function (part, index) {
        const item = document.createElement('li');
        if (index === parts.length - 1) {
          const current = document.createElement('span');
          current.setAttribute('aria-current', 'page');
          current.appendChild(part);
          item.appendChild(current);
        } else {
          if (part.nodeType === Node.ELEMENT_NODE && part.matches('a') && part.textContent.trim().toLowerCase() === 'home') {
            part.href = '/';
            part.textContent = 'Home';
          }
          item.appendChild(part);
        }
        list.appendChild(item);
      });
      navigation.classList.add('breadcrumb-nav');
      navigation.replaceChildren(list);
    });
  }

  function setupMobileBottomNavigation() {
    if (document.querySelector('.mobile-bottom-navigation')) return;

    const pagePath = window.location.pathname;
    const items = [
      {
        label: 'Home',
        href: '/',
        className: 'mobile-bottom-home',
        active: pagePath === '/' || pagePath === '/index.html',
        icon: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z"/>'
      },
      {
        label: 'Categories',
        href: '/categories',
        active: ['/products', '/products.html', '/product-detail.html'].includes(pagePath),
        icon: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>'
      },
      {
        label: 'Messenger',
        href: '/messenger.html',
        active: pagePath === '/messenger.html',
        icon: '<path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.5 8.5 0 0 1-3.5-.75L4 20l1.4-3.5A7.2 7.2 0 0 1 4 12c0-4.1 3.6-7.5 8-7.5s8 3.1 8 7z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>'
      },
      {
        label: 'Cart',
        href: '/cart.html',
        active: ['/cart.html', '/checkout.html'].includes(pagePath),
        icon: '<path d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 1.9-1.4L21 8H6"/><circle cx="10" cy="19" r="1"/><circle cx="18" cy="19" r="1"/>'
      },
      {
        label: 'My Account',
        href: '/account.html',
        active: ['/account.html', '/login.html', '/register.html', '/forgot-password.html', '/reset-password.html', '/orders.html', '/order-detail.html', '/order-confirmation.html', '/payment-status.html'].includes(pagePath),
        icon: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'
      }
    ];
    const navigation = document.createElement('nav');
    navigation.className = 'mobile-bottom-navigation';
    navigation.setAttribute('aria-label', 'Mobile navigation');

    items.forEach(function (item) {
      const link = document.createElement('a');
      link.className = 'mobile-bottom-navigation-item' + (item.className ? ' ' + item.className : '');
      link.href = item.href;
      if (item.active) {
        link.classList.add('is-active');
        link.setAttribute('aria-current', 'page');
      }

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      icon.innerHTML = item.icon;

      if (item.className === 'mobile-bottom-home') {
        const homeIcon = document.createElement('span');
        homeIcon.className = 'mobile-bottom-home-icon';
        homeIcon.appendChild(icon);
        link.append(homeIcon, document.createTextNode(item.label));
      } else {
        link.append(icon, document.createTextNode(item.label));
      }
      navigation.appendChild(link);
    });

    document.body.appendChild(navigation);
  }

  setupMobileBottomNavigation();

  function bindThemeToggle(themeToggle) {
    if (!themeToggle || themeToggle.dataset.themeToggleBound === 'true') return;
    themeToggle.dataset.themeToggleBound = 'true';
    themeToggle.textContent = currentColorTheme === 'dark' ? 'Light mode' : 'Dark mode';
    themeToggle.setAttribute('aria-pressed', String(currentColorTheme === 'dark'));
    themeToggle.addEventListener('click', function () {
      currentColorTheme = currentColorTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = currentColorTheme;
      if (browserThemeColor) browserThemeColor.content = currentColorTheme === 'dark' ? '#111827' : '#123f35';
      themeToggle.textContent = currentColorTheme === 'dark' ? 'Light mode' : 'Dark mode';
      themeToggle.setAttribute('aria-pressed', String(currentColorTheme === 'dark'));
      try {
        window.localStorage.setItem(colorThemeStorageKey, currentColorTheme);
      } catch (error) {
        console.error('Could not save the color theme preference:', error);
      }
    });
  }

  function setupSharedNavigation() {
    const pageRole = document.body.dataset.requiresRole || '';
    const role = pageRole || (currentUser && currentUser.role) || '';
    const pagePath = window.location.pathname;
    const mainNavigation = document.querySelector('header .main-nav, body > .main-nav');
    if (mainNavigation) {
      const shell = mainNavigation.querySelector('.container') || mainNavigation;
      shell.replaceChildren();
      const links = document.createElement('div');
      links.className = 'nav-links';
      const definitions = role === 'admin'
        ? [
          ['Dashboard', '/admin-dashboard.html'],
          ['Vendors', '/admin-vendors.html'],
          ['Products', '/admin-products.html'],
          ['Orders', '/admin-orders.html'],
          ['Freight', '/admin-freight.html'],
          ['Payments', '/admin-payments.html'],
          ['Audit', '/admin-audit.html'],
          ['Marketplace', '/products']
        ]
        : role === 'vendor'
          ? [
            ['Dashboard', '/vendor-dashboard.html'],
            ['Products', '/vendor-products.html'],
            ['Orders', '/vendor-orders.html'],
            ['Application', '/vendor-application.html'],
            ['Marketplace', '/products'],
            ['Settings', null]
          ]
          : [
            ['Home', '/'],
            ['Shop', '/products'],
            ['Cart', '/cart.html'],
            ['My orders', '/orders.html'],
            ['Settings', null],
            ['Sell', '/register.html?role=vendor']
          ];
      definitions.forEach(function (definition) {
        if (definition[0] === 'Settings') {
          const settingsMenu = document.createElement('details');
          settingsMenu.className = 'settings-navigation';
          const summary = document.createElement('summary');
          summary.textContent = 'Settings';
          const panel = document.createElement('div');
          panel.className = 'settings-navigation-panel';
          const settingsDefinitions = [['Account', '/account.html'], ['Help', '/help.html']];
          settingsDefinitions.forEach(function (settingDefinition) {
            const settingLink = document.createElement('a');
            settingLink.href = settingDefinition[1];
            settingLink.textContent = settingDefinition[0];
            if (pagePath === new URL(settingDefinition[1], window.location.origin).pathname) {
              settingLink.setAttribute('aria-current', 'page');
            }
            panel.appendChild(settingLink);
          });
          settingsMenu.append(summary, panel);
          const mobileNavigationQuery = window.matchMedia('(max-width: 760px)');
          settingsMenu.open = !mobileNavigationQuery.matches;
          const syncSettingsMenu = function (event) {
            settingsMenu.open = !event.matches;
          };
          if (mobileNavigationQuery.addEventListener) {
            mobileNavigationQuery.addEventListener('change', syncSettingsMenu);
          } else {
            mobileNavigationQuery.addListener(syncSettingsMenu);
          }
          links.appendChild(settingsMenu);
          return;
        }
        const link = document.createElement('a');
        link.href = definition[1];
        link.textContent = definition[0];
        const targetPath = new URL(definition[1], window.location.origin).pathname;
        if (pagePath === targetPath || (targetPath === '/products' && ['/products', '/product-detail.html'].includes(pagePath))) {
          link.setAttribute('aria-current', 'page');
        }
        links.appendChild(link);
      });
      if (!pageRole && role !== 'admin') {
        const categoryMenu = document.createElement('details');
        categoryMenu.className = 'category-navigation';
        const summary = document.createElement('summary');
        summary.textContent = 'Categories';
        const panel = document.createElement('div');
        panel.className = 'category-navigation-panel';
        const all = document.createElement('a');
        all.className = 'category-all-link';
        all.href = '/products';
        all.textContent = 'Shop all products';
        const status = document.createElement('p');
        status.className = 'category-navigation-status';
        status.setAttribute('aria-live', 'polite');
        status.textContent = 'Loading categories...';
        const options = document.createElement('div');
        options.className = 'category-navigation-options';
        panel.append(all, status, options);
        categoryMenu.append(summary, panel);
        links.appendChild(categoryMenu);
        loadNavigationCategories(categoryMenu);
      }
      const themeToggle = document.createElement('button');
      themeToggle.className = 'theme-toggle';
      themeToggle.type = 'button';
      bindThemeToggle(themeToggle);
      links.appendChild(themeToggle);
      shell.appendChild(links);
    }

    if (role === 'vendor' && currentUser && mainNavigation && !document.getElementById('authToggle')) {
      const signOut = document.createElement('button');
      signOut.id = 'authToggle';
      signOut.className = 'nav-button';
      signOut.type = 'button';
      signOut.textContent = 'Sign Out';
      mainNavigation.appendChild(signOut);
      updateAuthControl();
    }
    addInstallButton(mainNavigation);
    bindThemeToggle(document.getElementById('profileThemeToggle'));
    bindThemeToggle(document.getElementById('mobileThemeToggle'));
    const mobileSettingsButton = document.getElementById('mobileSettingsButton');
    const mobileSettingsDialog = document.getElementById('mobileSettingsDialog');
    const mobileSettingsClose = document.getElementById('mobileSettingsClose');
    if (mobileSettingsButton && mobileSettingsDialog && mobileSettingsClose) {
      mobileSettingsButton.addEventListener('click', function () {
        mobileSettingsDialog.showModal();
      });
      mobileSettingsClose.addEventListener('click', function () {
        mobileSettingsDialog.close();
      });
    }

    const header = document.querySelector('body > header');
    if (header && !header.querySelector('.search-shell, .global-market-search, #keywordSearch, form[role="search"]')) {
      const search = document.createElement('form');
      search.className = 'global-market-search';
      search.action = '/products';
      search.method = 'get';
      search.setAttribute('role', 'search');
      search.setAttribute('aria-label', 'Search the marketplace');
      const input = document.createElement('input');
      input.type = 'search';
      input.name = 'q';
      input.maxLength = 100;
      input.placeholder = 'Search products';
      input.setAttribute('aria-label', 'Search products');
      input.value = new URLSearchParams(window.location.search).get('q') || '';
      const button = document.createElement('button');
      button.type = 'submit';
      button.textContent = 'Search';
      search.append(input, button);
      const headerInner = header.querySelector('.topbar-inner, .nav-wrap, .container') || header;
      const brand = headerInner.querySelector('.brand-logo-link, .brand');
      if (brand && brand.nextSibling) headerInner.insertBefore(search, brand.nextSibling);
      else headerInner.appendChild(search);
    }

    if (header && !pageRole && role !== 'admin' && !header.querySelector('[data-deliver-to]')) {
      const headerInner = header.querySelector('.topbar-inner, .nav-wrap, .container') || header;
      const deliverBox = document.createElement('div');
      deliverBox.className = 'deliver-box';
      deliverBox.setAttribute('aria-label', 'Deliver to province');
      const details = document.createElement('div');
      const label = document.createElement('div');
      label.className = 'deliver-label';
      label.textContent = 'Deliver to';
      const value = document.createElement('div');
      value.className = 'deliver-value';
      value.dataset.deliverTo = '';
      value.textContent = provinceLabel(getSavedDeliveryProvince()) || 'Not selected';
      details.append(label, value);
      deliverBox.appendChild(details);
      const brand = headerInner.querySelector('.brand-logo-link, .brand');
      if (brand && brand.nextSibling) headerInner.insertBefore(deliverBox, brand.nextSibling);
      else headerInner.appendChild(deliverBox);
    }

    let footer = document.querySelector('body > footer, body > .site-footer');
    if (!footer) {
      footer = document.createElement('footer');
      footer.className = 'site-footer';
      document.body.appendChild(footer);
    }
    footer.classList.add('site-footer');
    let footerInner = footer.querySelector('.footer-inner');
    if (!footerInner) {
      footerInner = document.createElement('div');
      footerInner.className = 'container footer-inner';
      while (footer.firstChild) footerInner.appendChild(footer.firstChild);
      footer.appendChild(footerInner);
    }
    let footerBrand = footerInner.querySelector('p');
    if (!footerBrand) {
      footerBrand = document.createElement('p');
      footerInner.prepend(footerBrand);
    }
    footerBrand.className = 'global-footer-brand';
    footerBrand.textContent = '\u00a9 ' + new Date().getFullYear() + ' KEDOLAKA MARKET. All rights reserved.';

    let footerLinks = footerInner.querySelector('.global-footer-links, .footer-links, nav, div:last-child');
    if (footerLinks && footerLinks.tagName !== 'NAV') {
      const navigation = document.createElement('nav');
      footerLinks.replaceWith(navigation);
      footerLinks = navigation;
    }
    if (!footerLinks) {
      footerLinks = document.createElement('nav');
      footerInner.appendChild(footerLinks);
    }
    footerLinks.replaceChildren();
    footerLinks.className = 'global-footer-links';
    footerLinks.setAttribute('aria-label', 'Marketplace links');
    [['Home', '/'], ['Shop products', '/products'], ['My orders', '/orders.html'], ['Help', '/help.html']].forEach(function (definition) {
      const link = document.createElement('a');
      link.href = definition[1];
      link.textContent = definition[0];
      footerLinks.appendChild(link);
    });
    setupMobileBottomNavigation();
  }

  async function loadNavigationCategories(menu) {
    const status = menu.querySelector('.category-navigation-status');
    const options = menu.querySelector('.category-navigation-options');
    try {
      const result = await api('/api/products/categories');
      options.replaceChildren();
      if (!result.categories.length) {
        status.textContent = 'No product categories are currently available.';
        return;
      }
      status.textContent = '';
      result.categories.forEach(function (category) {
        const link = document.createElement('a');
        link.href = '/products?category=' + encodeURIComponent(category);
        link.textContent = category;
        options.appendChild(link);
      });
    } catch (error) {
      status.textContent = 'Categories could not be loaded.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', function () {
        options.replaceChildren();
        status.textContent = 'Loading categories...';
        loadNavigationCategories(menu);
      });
      options.replaceChildren(retry);
    }
  }

  function money(value) {
    return 'K ' + Number(value || 0).toFixed(2);
  }

  async function loadSession() {
    sessionError = null;
    try {
      const result = await api('/api/auth/session');
      currentUser = result.user;
    } catch (error) {
      currentUser = null;
      if (error.status !== 401) sessionError = error;
    }
    const deliveryProvince = getSavedDeliveryProvince() || (currentUser ? currentUser.homeProvince : '');
    updateDeliveryDisplay(deliveryProvince);
    const sessionProvince = document.getElementById('sessionProvinceSelect');
    if (sessionProvince && deliveryProvince) sessionProvince.value = deliveryProvince;
    const checkoutProvince = document.getElementById('deliveryProvince');
    if (checkoutProvince && deliveryProvince && Array.from(checkoutProvince.options).some(function (option) {
      return option.value === deliveryProvince;
    })) checkoutProvince.value = deliveryProvince;
    updateAuthControl();
    return currentUser;
  }

  async function applyDeliveryProvince() {
    const select = document.getElementById('sessionProvinceSelect');
    const status = document.getElementById('statusUpdate');
    if (!select) return;
    const province = select.value;
    if (!province) return;
    if (currentUser) {
      try {
        const result = await api('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ homeProvince: province }) });
        currentUser = result.user;
      } catch (error) {
        updateDeliveryDisplay(currentUser.homeProvince);
        if (status) status.textContent = error.message;
        return;
      }
    }
    saveDeliveryProvince(province);
    if (status) status.textContent = 'Delivery province set to ' + provinceLabel(province) + '.';
  }

  function updateAuthControl() {
    const navigation = document.querySelector('header .main-nav, body > .main-nav');
    if (navigation && currentUser && currentUser.role === 'admin' && !document.getElementById('adminWorkspaceLink')) {
      const adminLink = document.createElement('a');
      adminLink.id = 'adminWorkspaceLink';
      adminLink.href = 'admin-dashboard.html';
      adminLink.textContent = 'Administration';
      navigation.appendChild(adminLink);
    }
    const control = document.getElementById('authToggle');
    if (!control) return;
    if (sessionError) {
      control.textContent = 'Account unavailable';
      control.onclick = function () { window.alert(sessionError.message); };
      return;
    }
    control.textContent = currentUser ? 'Sign Out' : 'Sign In';
    control.onclick = async function () {
      if (!currentUser) {
        window.location.href = 'login.html?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search);
        return;
      }
      control.disabled = true;
      try {
        await api('/api/auth/logout', { method: 'POST' });
        currentUser = null;
        window.location.href = 'index.html';
      } catch (error) {
        window.alert(error.message);
        control.disabled = false;
      }
    };
  }

  function safeReturnTo(defaultDestination) {
    const requested = new URLSearchParams(window.location.search).get('returnTo');
    if (!requested) return defaultDestination || 'account.html';
    try {
      const destination = new URL(requested, window.location.origin);
      if (destination.origin !== window.location.origin || !destination.pathname.startsWith('/')) return defaultDestination || 'account.html';
      if (/\/(?:login|register|forgot-password|reset-password|auth|auth-flow)\.html$/i.test(destination.pathname)) return defaultDestination || 'account.html';
      return destination.pathname + destination.search + destination.hash;
    } catch (error) {
      return defaultDestination || 'account.html';
    }
  }

  function guardPageAccess() {
    const body = document.body;
    if (!body) return;
    const requiresAuth = body.dataset.requiresAuth === 'true';
    const requiredRole = body.dataset.requiresRole;
    if ((requiresAuth && !currentUser) || (requiredRole && (!currentUser || currentUser.role !== requiredRole))) {
      if (!currentUser) {
        const destination = window.location.pathname + window.location.search;
        window.location.replace('login.html?returnTo=' + encodeURIComponent(destination));
        return;
      }
      const status = document.getElementById(requiredRole === 'admin' ? 'adminMessage' : 'vendorMessage');
      showMessage(status, requiredRole === 'admin'
        ? 'Administrator access is required. Your account cannot access this page.'
        : 'A vendor account is required. You can apply from the account registration page.', 'error');
      const protectedRoot = document.getElementById(requiredRole === 'admin' ? 'adminWorkspace' : 'vendorWorkspace');
      if (protectedRoot) Array.from(protectedRoot.children).forEach(function (node) {
        if (node !== status) node.hidden = true;
      });
      document.querySelectorAll('[data-protected-content]').forEach(function (node) { node.hidden = true; });
    }
  }

  function updateCartBadge(count) {
    document.querySelectorAll('.cart-badge').forEach(function (badge) {
      badge.textContent = text(count);
    });
  }

  async function refreshCartCount() {
    if (!currentUser) {
      updateCartBadge(sessionError ? '–' : 0);
      return;
    }
    try {
      const result = await api('/api/cart');
      updateCartBadge(result.items.reduce(function (sum, item) { return sum + Number(item.quantity); }, 0));
    } catch (error) {
      updateCartBadge('–');
      console.error('Could not refresh the cart count.');
    }
  }

  function buildProductCard(product) {
    const card = document.createElement('article');
    card.className = 'product-card';
    const visual = document.createElement('div');
    visual.className = 'product-visual visual-gold';
    if (product.image_url) {
      const image = document.createElement('img');
      image.src = product.image_url;
      image.alt = text(product.product_name);
      image.loading = 'lazy';
      image.addEventListener('error', function () {
        visual.textContent = 'Image unavailable';
      }, { once: true });
      visual.appendChild(image);
    } else {
      visual.textContent = 'Image unavailable';
    }
    const meta = document.createElement('div');
    meta.className = 'product-meta';
    const category = document.createElement('span');
    category.className = 'badge badge-gold';
    category.textContent = text(product.category);
    const title = document.createElement('h3');
    const link = document.createElement('a');
    link.href = 'product-detail.html?id=' + encodeURIComponent(product.product_id);
    link.textContent = text(product.product_name);
    title.appendChild(link);
    const row = document.createElement('div');
    row.className = 'product-row';
    const price = document.createElement('strong');
    price.textContent = money(product.price_kina);
    const location = document.createElement('span');
    location.textContent = provinceLabel(product.province);
    row.append(price, location);
    const seller = document.createElement('p');
    seller.textContent = `${Number(product.stock_quantity)} available · ${deliveryTypeLabel(product.delivery_type)}`;
    if (product.business_name) seller.textContent = text(product.business_name) + ' · ' + seller.textContent;
    const details = document.createElement('a');
    details.className = 'btn btn-secondary';
    details.href = '/product-detail.html?id=' + encodeURIComponent(product.product_id);
    details.textContent = 'View full details';
    meta.append(category, title, row, seller, details);
    card.append(visual, meta);
    return card;
  }

  async function loadProducts() {
    const grid = document.getElementById('productGrid');
    if (!grid) return;
    grid.classList.remove('empty-product-grid');
    grid.textContent = 'Loading products...';
    const params = new URLSearchParams();
    const query = new URLSearchParams(window.location.search);
    const search = document.getElementById('keywordSearch');
    const category = document.getElementById('categoryFilter');
    const province = document.getElementById('provinceFilter');
    const sort = document.getElementById('sortFilter');
    const minimumPrice = document.getElementById('minimumPriceFilter');
    const maximumPrice = document.getElementById('maximumPriceFilter');
    const provinceSelect = document.getElementById('sessionProvinceSelect');
    if (search && query.has('q')) search.value = query.get('q');
    if (category && query.has('category')) category.value = query.get('category');
    if (province && query.has('province')) province.value = query.get('province');
    if (sort && query.has('sort')) sort.value = query.get('sort');
    if (minimumPrice && query.has('minPrice')) minimumPrice.value = query.get('minPrice');
    if (maximumPrice && query.has('maxPrice')) maximumPrice.value = query.get('maxPrice');
    if (provinceSelect && currentUser) provinceSelect.value = currentUser.homeProvince;
    if (search && search.value.trim()) params.set('q', search.value.trim());
    const selectedCategory = category && query.has('category') ? query.get('category') : category && category.value;
    if (selectedCategory && selectedCategory !== 'all') params.set('category', selectedCategory);
    if (province && province.value && province.value !== 'all') params.set('province', province.value);
    if (sort && sort.value) params.set('sort', sort.value);
    if (minimumPrice && minimumPrice.value) params.set('minPrice', minimumPrice.value);
    if (maximumPrice && maximumPrice.value) params.set('maxPrice', maximumPrice.value);
    params.set('limit', String(catalogLimit));
    params.set('offset', String(catalogOffset));
    try {
      const result = await api('/api/products?' + params.toString());
      grid.replaceChildren();
      let pagination = document.getElementById('productPagination');
      if (!pagination) {
        pagination = document.createElement('nav');
        pagination.id = 'productPagination';
        pagination.setAttribute('aria-label', 'Product pages');
        grid.insertAdjacentElement('afterend', pagination);
      }
      pagination.replaceChildren();
      if (!result.products.length) {
        grid.textContent = 'No listed products match these filters.';
        grid.classList.add('empty-product-grid');
        return;
      }
      grid.classList.add('product-grid');
      result.products.forEach(function (product) { grid.appendChild(buildProductCard(product)); });
      if (result.total > catalogLimit) {
        const previous = document.createElement('button');
        previous.type = 'button';
        previous.textContent = 'Previous';
        previous.disabled = catalogOffset === 0;
        previous.addEventListener('click', function () { catalogOffset = Math.max(0, catalogOffset - catalogLimit); loadProducts(); });
        const page = document.createElement('span');
        page.textContent = `${catalogOffset + 1}-${Math.min(catalogOffset + result.products.length, result.total)} of ${result.total}`;
        const next = document.createElement('button');
        next.type = 'button';
        next.textContent = 'Next';
        next.disabled = catalogOffset + catalogLimit >= result.total;
        next.addEventListener('click', function () { catalogOffset += catalogLimit; loadProducts(); });
        pagination.append(previous, page, next);
      }
    } catch (error) {
      grid.replaceChildren();
      const message = document.createElement('p');
      message.textContent = error.message;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', loadProducts);
      grid.append(message, retry);
      grid.classList.add('empty-product-grid');
    }
  }

  async function loadCategories() {
    const select = document.getElementById('categoryFilter');
    const status = document.getElementById('categoryStatus');
    const featured = document.getElementById('featuredCategories');
    if (!select && !featured) return;
    try {
      const result = await api('/api/products/categories');
      const query = new URLSearchParams(window.location.search);
      const selected = select ? (query.get('category') || select.value) : '';
      if (select) {
        select.replaceChildren(new Option('All Categories', 'all'));
        result.categories.forEach(function (category) {
          select.add(new Option(category, category));
        });
        if (result.categories.includes(selected)) select.value = selected;
      }
      if (featured) {
        featured.replaceChildren();
        result.categories.forEach(function (category) {
          const link = document.createElement('a');
          link.href = '/products?category=' + encodeURIComponent(category);
          link.textContent = category;
          if (featured.tagName === 'UL') {
            const item = document.createElement('li');
            item.appendChild(link);
            featured.appendChild(item);
          } else {
            link.className = 'category-chip';
            featured.appendChild(link);
          }
        });
      }
      if (status) status.textContent = result.categories.length ? '' : 'No product categories have listed products yet.';
    } catch (error) {
      if (status) status.textContent = 'Product categories could not be loaded.';
      console.error('Could not load product categories.');
    }
  }

  function bindAuthForms() {
    document.querySelectorAll('.password-visibility-toggle').forEach(function (toggle) {
      toggle.addEventListener('click', function () {
        const input = document.getElementById(toggle.getAttribute('aria-controls'));
        if (!input) return;
        const revealed = input.type === 'password';
        input.type = revealed ? 'text' : 'password';
        toggle.setAttribute('aria-label', revealed ? 'Hide password' : 'Show password');
        toggle.setAttribute('aria-pressed', String(revealed));
        toggle.classList.toggle('is-visible', revealed);
      });
    });

    const signIn = document.getElementById('signInForm');
    if (signIn) signIn.addEventListener('submit', async function (event) {
      event.preventDefault();
      const button = signIn.querySelector('button[type="submit"]');
      const status = document.getElementById('signInStatus');
      button.disabled = true;
      showMessage(status, 'Signing in...');
      try {
        const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({
          email: document.getElementById('signInEmail').value,
          password: document.getElementById('signInPassword').value
        }) });
        showMessage(status, 'Signed in. Redirecting...', 'success');
        window.location.assign(safeReturnTo(result.user.role === 'vendor' ? 'vendor-application.html' : 'account.html'));
      } catch (error) {
        showMessage(status, error.message, 'error');
      } finally { button.disabled = false; }
    });

    const register = document.getElementById('registerForm');
    if (register) {
      const roleSelect = document.getElementById('registerRole');
      const vendorSetup = document.getElementById('registrationVendorSetup');
      const vendorSetupFields = document.getElementById('registrationPaymentMethods');
      const businessName = document.getElementById('registerBusinessName');
      const businessProvince = document.getElementById('registerBusinessProvince');
      const registrationNext = document.getElementById('registrationNext');
      const registrationBack = document.getElementById('registrationBack');
      const registrationSteps = Array.from(register.querySelectorAll('[data-registration-step]'));
      let activeRegistrationStep = 1;
      renderVendorPaymentSetup(vendorSetupFields);
      function showRegistrationStep(step) {
        activeRegistrationStep = step;
        registrationSteps.forEach(function (section) {
          section.hidden = Number(section.dataset.registrationStep) !== step;
        });
        const heading = register.querySelector('[data-registration-step="' + step + '"] h2');
        if (heading) heading.focus();
      }
      if (registrationNext) registrationNext.addEventListener('click', function () {
        const step = register.querySelector('[data-registration-step="1"]');
        const controls = Array.from(step.querySelectorAll('input, select, textarea'));
        const invalid = controls.find(function (control) { return !control.checkValidity(); });
        if (invalid) {
          invalid.reportValidity();
          return;
        }
        if (document.getElementById('registerPassword').value !== document.getElementById('confirmPassword').value) {
          showMessage(document.getElementById('registerStatus'), 'Passwords do not match.', 'error');
          document.getElementById('confirmPassword').focus();
          return;
        }
        showMessage(document.getElementById('registerStatus'), '');
        showRegistrationStep(2);
      });
      if (registrationBack) registrationBack.addEventListener('click', function () {
        showRegistrationStep(1);
      });
      function syncRegistrationRole() {
        const isVendor = roleSelect && roleSelect.value === 'vendor';
        if (vendorSetup) vendorSetup.hidden = !isVendor;
        if (businessName) businessName.required = Boolean(isVendor);
        if (businessProvince) businessProvince.required = Boolean(isVendor);
      }
      if (roleSelect) roleSelect.addEventListener('change', syncRegistrationRole);
      if (roleSelect && new URLSearchParams(window.location.search).get('role') === 'vendor') {
        roleSelect.value = 'vendor';
      }
      syncRegistrationRole();
      showRegistrationStep(1);
      register.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (activeRegistrationStep !== 2) {
        showRegistrationStep(2);
        return;
      }
      const status = document.getElementById('registerStatus');
      const button = register.querySelector('button[type="submit"]');
      const password = document.getElementById('registerPassword').value;
      if (password !== document.getElementById('confirmPassword').value) {
        showMessage(status, 'Passwords do not match.', 'error');
        return;
      }
      const isVendor = document.getElementById('registerRole').value === 'vendor';
      const vendorMethods = isVendor ? readVendorPaymentSetup(vendorSetupFields) : [];
      const vendorPaymentError = isVendor ? getVendorPaymentSetupError(vendorSetupFields) : '';
      if (vendorPaymentError) {
        showMessage(status, vendorPaymentError, 'error');
        return;
      }
      button.disabled = true;
      showMessage(status, 'Creating account...');
      try {
        const registration = {
          fullName: document.getElementById('fullName').value,
          email: document.getElementById('registerEmail').value,
          phoneNumber: document.getElementById('registerPhone').value,
          password,
          role: document.getElementById('registerRole').value,
          homeProvince: document.getElementById('registerProvince').value
        };
        if (isVendor) {
          registration.businessName = businessName.value;
          registration.businessProvince = businessProvince.value;
          registration.vendorPaymentMethods = vendorMethods;
        }
        const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(registration) });
        showMessage(status, result.message + (result.user.role === 'vendor' ? ' Vendor features unlock after approval.' : ''), 'success');
        const returnTo = new URLSearchParams(window.location.search).get('returnTo');
        window.location.assign(result.user.role === 'vendor' && !returnTo ? 'vendor-application.html' : safeReturnTo());
      } catch (error) {
        showMessage(status, error.message, 'error');
      } finally { button.disabled = false; }
      });
    }

    const forgot = document.getElementById('forgotPasswordForm');
    if (forgot) forgot.addEventListener('submit', async function (event) {
      event.preventDefault();
      const status = document.getElementById('forgotStatus');
      try {
        const result = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: document.getElementById('forgotEmail').value }) });
        showMessage(status, result.message, 'success');
      } catch (error) { showMessage(status, error.message, 'error'); }
    });

    const resetToken = new URLSearchParams(window.location.search).get('reset');
    const resetPanel = document.getElementById('resetPanel');
    const resetStatus = document.getElementById('resetTokenStatus');
    if (resetToken && resetPanel) {
      resetPanel.hidden = false;
      const reset = document.getElementById('resetPasswordForm');
      reset.addEventListener('submit', async function (event) {
        event.preventDefault();
        const status = document.getElementById('resetStatus');
        try {
          const result = await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: resetToken, password: document.getElementById('resetPassword').value }) });
          showMessage(status, result.message, 'success');
        } catch (error) { showMessage(status, error.message, 'error'); }
      });
    } else if (resetPanel && resetStatus) {
      resetPanel.hidden = true;
      showMessage(resetStatus, 'Open the password-reset link sent to your email to set a new password.', 'error');
    }
  }

  async function initMessenger() {
    const conversationList = document.getElementById('conversationList');
    if (!conversationList) return;

    const status = document.getElementById('messengerStatus');
    const newConversationForm = document.getElementById('newConversationForm');
    const vendorSelect = document.getElementById('messengerVendor');
    const firstMessage = document.getElementById('firstMessage');
    const threadHeading = document.getElementById('threadHeading');
    const messageList = document.getElementById('messageList');
    const replyForm = document.getElementById('replyForm');
    const replyMessage = document.getElementById('replyMessage');
    let conversations = [];
    let selectedConversationId = null;

    if (!currentUser) {
      showMessage(status, 'Sign in to use Messenger.', 'error');
      conversationList.replaceChildren();
      return;
    }

    function showMessengerError(error) {
      if (status) status.textContent = error.message;
    }

    async function loadMessages(conversationId) {
      const result = await api('/api/messaging/conversations/' + encodeURIComponent(conversationId) + '/messages');
      messageList.replaceChildren();
      result.messages.forEach(function (message) {
        const bubble = document.createElement('article');
        bubble.className = 'message-bubble' +
          (String(message.sender_user_id) === String(currentUser.id) ? ' is-own-message' : '');
        const body = document.createElement('p');
        body.textContent = message.message_body;
        const time = document.createElement('time');
        const createdAt = new Date(message.created_at);
        time.dateTime = createdAt.toISOString();
        time.textContent = message.sender_name + ' · ' +
          new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(createdAt);
        bubble.append(body, time);
        messageList.appendChild(bubble);
      });
      if (!result.messages.length) {
        const empty = document.createElement('p');
        empty.className = 'thread-empty';
        empty.textContent = 'No messages yet. Send a message to start the conversation.';
        messageList.appendChild(empty);
      }
      messageList.scrollTop = messageList.scrollHeight;
    }

    async function refreshConversations() {
      const result = await api('/api/messaging/conversations');
      conversations = result.conversations;
      conversationList.replaceChildren();
      if (!conversations.length) {
        const empty = document.createElement('p');
        empty.className = 'thread-empty';
        empty.textContent = 'No conversations yet. Choose a vendor above to start messaging.';
        conversationList.appendChild(empty);
      }
      conversations.forEach(function (conversation) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-current', String(String(conversation.conversation_id) === String(selectedConversationId)));
        const name = document.createElement('strong');
        name.textContent = conversation.other_party_name;
        const preview = document.createElement('span');
        preview.textContent = conversation.last_message || 'No messages yet';
        button.append(name, preview);
        button.addEventListener('click', async function () {
          selectedConversationId = conversation.conversation_id;
          if (status) status.textContent = '';
          threadHeading.replaceChildren();
          const heading = document.createElement('h2');
          heading.textContent = conversation.other_party_name;
          const description = document.createElement('p');
          description.textContent = conversation.is_vendor_conversation
            ? 'Conversation with this buyer'
            : 'Conversation with this vendor';
          threadHeading.append(heading, description);
          replyForm.hidden = false;
          try {
            await refreshConversations();
            await loadMessages(selectedConversationId);
          } catch (error) {
            showMessengerError(error);
          }
        });
        conversationList.appendChild(button);
      });

      if (selectedConversationId && !conversations.some(function (conversation) {
        return String(conversation.conversation_id) === String(selectedConversationId);
      })) {
        selectedConversationId = null;
      }
      if (selectedConversationId) {
        const active = Array.from(conversationList.querySelectorAll('button')).find(function (button, index) {
          return String(conversations[index].conversation_id) === String(selectedConversationId);
        });
        if (active) active.setAttribute('aria-current', 'true');
      }
    }

    newConversationForm.hidden = false;
    try {
      const result = await api('/api/messaging/vendors');
      result.vendors.forEach(function (vendor) {
        const option = document.createElement('option');
        option.value = vendor.vendor_id;
        option.textContent = vendor.business_name + ' · ' + vendor.province;
        vendorSelect.appendChild(option);
      });
      if (!result.vendors.length) {
        const option = new Option('No active vendors available', '');
        option.disabled = true;
        vendorSelect.appendChild(option);
      }
    } catch (error) {
      showMessengerError(error);
    }
    newConversationForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      const submitButton = newConversationForm.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      try {
        const result = await api('/api/messaging/conversations', {
          method: 'POST',
          body: JSON.stringify({ vendorId: vendorSelect.value, message: firstMessage.value })
        });
        selectedConversationId = result.conversationId;
        firstMessage.value = '';
        if (status) status.textContent = '';
        await refreshConversations();
        const conversation = conversations.find(function (item) {
          return String(item.conversation_id) === String(selectedConversationId);
        });
        if (conversation) {
          threadHeading.replaceChildren();
          const heading = document.createElement('h2');
          heading.textContent = conversation.other_party_name;
          const description = document.createElement('p');
          description.textContent = 'Conversation with this vendor';
          threadHeading.append(heading, description);
          replyForm.hidden = false;
          await loadMessages(selectedConversationId);
        }
      } catch (error) {
        showMessengerError(error);
      } finally {
        submitButton.disabled = false;
      }
    });

    replyForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!selectedConversationId) return;
      const submitButton = replyForm.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      try {
        await api('/api/messaging/conversations/' + encodeURIComponent(selectedConversationId) + '/messages', {
          method: 'POST',
          body: JSON.stringify({ message: replyMessage.value })
        });
        replyMessage.value = '';
        if (status) status.textContent = '';
        await Promise.all([loadMessages(selectedConversationId), refreshConversations()]);
      } catch (error) {
        showMessengerError(error);
      } finally {
        submitButton.disabled = false;
      }
    });

    try {
      await refreshConversations();
    } catch (error) {
      showMessengerError(error);
      conversationList.textContent = 'Could not load conversations.';
    }
    window.setInterval(function () {
      if (document.hidden) return;
      refreshConversations().then(function () {
        if (selectedConversationId) return loadMessages(selectedConversationId);
      }).catch(showMessengerError);
    }, 10000);
  }

  async function initAccountProfile() {
    const form = document.getElementById('profileForm');
    if (!form) return;
    const status = document.getElementById('accountStatus');
    if (!currentUser) return;
    const name = document.getElementById('accountName');
    const email = document.getElementById('accountEmail');
    const role = document.getElementById('accountRole');
    const province = document.getElementById('profileProvince');
    const roleLink = document.getElementById('accountRoleLink');
    if (name) name.textContent = text(currentUser.fullName || currentUser.full_name);
    if (email) email.textContent = text(currentUser.email);
    if (role) role.textContent = text(currentUser.role);
    if (province) province.value = currentUser.homeProvince || currentUser.home_province || 'NCD';
    if (roleLink && currentUser.role === 'vendor') {
      roleLink.href = '/vendor-dashboard.html';
      roleLink.textContent = 'Vendor dashboard';
      roleLink.hidden = false;
    } else if (roleLink && currentUser.role === 'admin') {
      roleLink.href = '/admin-dashboard.html';
      roleLink.textContent = 'Admin dashboard';
      roleLink.hidden = false;
    } else if (roleLink) {
      roleLink.href = '/vendor-application.html';
      roleLink.textContent = 'Vendor application';
      roleLink.hidden = false;
    }
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const result = await api('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ homeProvince: province.value }) });
        currentUser = result.user;
        saveDeliveryProvince(province.value);
        showMessage(status, 'Profile updated.', 'success');
      } catch (error) {
        showMessage(status, error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
    showMessage(status, 'Account details loaded.', 'success');
  }

  async function loadPaymentStatus() {
    const status = document.getElementById('paymentPageStatus');
    if (!status) return;
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
      showMessage(status, 'An order number is required to show payment status.', 'error');
      return;
    }
    try {
      const result = await api('/api/orders/' + encodeURIComponent(id));
      const order = result.order;
      const descriptions = {
        pending: 'Pending — payment has not been confirmed.',
        successful: order.vendor_confirmed_receipt
          ? 'The vendor confirmed receipt. This is the vendor’s attestation, not independent payment-provider verification.'
          : 'Payment has been marked successful by marketplace review; this does not indicate an online provider charge.',
        failed: 'Payment was not verified or was reported failed.',
        cancelled: 'Payment was cancelled.',
        expired: 'Payment reservation expired.',
        refunded: 'Payment was refunded.'
      };
      showMessage(status, 'Order #' + order.order_id + ': ' + (descriptions[order.payment_status] || 'Status: ' + order.payment_status));
      const method = document.getElementById('paymentMethodDetail');
      const total = document.getElementById('paymentTotal');
      const link = document.getElementById('paymentOrderLink');
      if (method) method.textContent = 'Method: ' + text(order.payment_method);
      if (total) total.textContent = 'Order total: ' + money(order.total_kina);
      if (link) link.href = 'order-detail.html?id=' + encodeURIComponent(order.order_id);
    } catch (error) {
      showMessage(status, error.message, 'error');
    }
  }

  async function loadCart() {
    const requestId = ++cartLoadRequest;
    const list = document.getElementById('cartItems');
    if (!list) return;
    if (!currentUser) {
      list.textContent = sessionError ? sessionError.message : 'Sign in to view your saved cart.';
      updateCartBadge(sessionError ? '–' : 0);
      const checkoutButton = document.getElementById('placeOrderButton');
      if (checkoutButton) checkoutButton.disabled = true;
      const cartCheckoutLink = document.getElementById('cartCheckoutLink');
      if (cartCheckoutLink) cartCheckoutLink.setAttribute('aria-disabled', 'true');
      return;
    }
    try {
      const checkoutProvince = document.getElementById('deliveryProvince');
      const query = checkoutProvince && checkoutProvince.value
        ? '?deliveryProvince=' + encodeURIComponent(checkoutProvince.value)
        : '';
      const result = await api('/api/cart' + query);
      if (requestId !== cartLoadRequest) return;
      cartItems = result.items;
      updateCartBadge(cartItems.reduce(function (sum, item) { return sum + Number(item.quantity); }, 0));
      checkoutLocalContactsReady = !checkoutProvince || !checkoutProvince.value || cartItems.every(function (item) {
        return item.province !== checkoutProvince.value || item.delivery_type === 'pickup' || Boolean(item.delivery_contact);
      });
      updateShippingProviderAvailability();
      renderVendorCheckoutMethods();
      list.replaceChildren();
      if (!cartItems.length) list.textContent = 'Your cart is empty.';
      cartItems.forEach(function (item) {
        const line = document.createElement('div');
        line.className = 'cart-item';
        line.dataset.productId = String(item.product_id);
        const label = document.createElement('div');
        label.className = 'item-meta';
        const name = document.createElement('strong');
        name.textContent = text(item.product_name);
        const detail = document.createElement('small');
        const conditionLabels = { new: 'New', used: 'Used', refurbished: 'Refurbished' };
        detail.textContent = money(item.price_kina) + ' / ' + text(item.price_unit || 'item') + ' · ' + item.stock_quantity + ' in stock · ' +
          (conditionLabels[item.item_condition] || text(item.item_condition)) + ' · ' + deliveryTypeLabel(item.delivery_type);
        if (!item.available) detail.textContent += ' · Unavailable; remove before checkout';
        label.append(name, detail);
        if (document.getElementById('placeOrderButton')) {
          const fulfillment = document.createElement('dl');
          fulfillment.className = 'checkout-item-fulfillment';
          const entries = [
            ['Condition', conditionLabels[item.item_condition] || text(item.item_condition)],
            ['Price applies to', item.price_unit || 'item'],
            ['Seller province', provinceLabel(item.province)],
            ['Delivery or pickup', deliveryTypeLabel(item.delivery_type)]
          ];
          const detailLabels = {
            brand: 'Brand or manufacturer',
            model: 'Model or SKU',
            dimensions: 'Size, dimensions, or weight',
            materials: 'Materials or ingredients',
            origin: 'Country or province of origin',
            warranty: 'Warranty and returns',
            deliveryAreas: 'Areas or provinces served',
            dispatchTime: 'Preparation or dispatch time',
            deliveryEstimate: 'Estimated delivery time',
            pickupDetails: 'Pickup location and arrangements',
            deliveryRestrictions: 'Delivery restrictions'
          };
          Object.keys(detailLabels).forEach(function (field) {
            const value = item.additional_details && item.additional_details[field];
            if (value) entries.push([detailLabels[field], value]);
          });
          if (item.delivery_notes) entries.push(['Delivery or pickup notes', item.delivery_notes]);
          entries.forEach(function (entry) {
            const term = document.createElement('dt');
            term.textContent = entry[0];
            const description = document.createElement('dd');
            description.textContent = text(entry[1]);
            fulfillment.append(term, description);
          });
          appendCheckoutLocalContact(fulfillment, item);
          label.appendChild(fulfillment);
        }
        const quantity = document.createElement('input');
        quantity.type = 'number';
        quantity.min = '1';
        quantity.max = String(item.stock_quantity);
        quantity.value = String(item.quantity);
        quantity.disabled = !item.available;
        quantity.setAttribute('aria-label', 'Quantity for ' + item.product_name);
        quantity.addEventListener('change', async function () {
          const nextQuantity = Number(quantity.value);
          try {
            await api('/api/cart/items/' + item.product_id, { method: 'PUT', body: JSON.stringify({ quantity: nextQuantity }) });
            await loadCart();
          } catch (error) { window.alert(error.message); await loadCart(); }
        });
        const amount = document.createElement('strong');
        amount.className = 'line-total';
        amount.textContent = money(Math.round(Number(item.price_kina) * 100) * Number(item.quantity) / 100);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-secondary';
        remove.textContent = 'Remove';
        remove.addEventListener('click', async function () {
          try { await api('/api/cart/items/' + item.product_id, { method: 'DELETE' }); await loadCart(); }
          catch (error) { window.alert(error.message); }
        });
        line.append(label, quantity, amount, remove);
        list.appendChild(line);
      });
      const subtotal = cartItems.reduce(function (sum, item) {
        return sum + Math.round(Number(item.price_kina) * 100) * Number(item.quantity);
      }, 0) / 100;
      const subtotalNode = document.getElementById('subtotalValue');
      const totalNode = document.getElementById('totalValue');
      const shippingNode = document.getElementById('shippingEstimate');
      const checkoutButton = document.getElementById('placeOrderButton');
      if (subtotalNode) subtotalNode.textContent = money(subtotal);
      if (shippingNode) shippingNode.textContent = 'Not estimated';
      if (totalNode) totalNode.textContent = 'Calculated at checkout';
      const cartCheckoutLink = document.getElementById('cartCheckoutLink');
      if (cartCheckoutLink) {
        const unavailable = !cartItems.length || cartItems.some(function (item) { return !item.available; });
        cartCheckoutLink.setAttribute('aria-disabled', unavailable ? 'true' : 'false');
      }
      if (checkoutButton) updateCheckoutAvailability();
      await refreshFreightEstimate();
    } catch (error) {
      if (requestId !== cartLoadRequest) return;
      list.textContent = error.message;
      const checkoutButton = document.getElementById('placeOrderButton');
      if (checkoutButton) checkoutButton.disabled = true;
      const cartCheckoutLink = document.getElementById('cartCheckoutLink');
      if (cartCheckoutLink) cartCheckoutLink.setAttribute('aria-disabled', 'true');
    }
  }

  function appendCheckoutLocalContact(fulfillment, item) {
    const contact = item.delivery_contact;
    if (!contact || item.delivery_type === 'pickup') return;
    [
      ['Driver or skipper', contact.name],
      ['Phone or WhatsApp', contact.phone],
      ['Vehicle, boat, or transport provider', contact.transport],
      ['Route and pickup/drop-off point', contact.route]
    ].forEach(function (entry) {
      if (!entry[1]) return;
      const term = document.createElement('dt');
      term.className = 'checkout-item-local-contact';
      term.textContent = entry[0];
      const description = document.createElement('dd');
      description.className = 'checkout-item-local-contact';
      description.textContent = text(entry[1]);
      fulfillment.append(term, description);
    });
  }

  async function refreshCheckoutLocalContacts() {
    const list = document.getElementById('cartItems');
    const province = document.getElementById('deliveryProvince');
    if (!list || !province || !province.value) return;
    const requestId = ++checkoutContactRequest;
    const destination = province.value;
    const hasDestinationDelivery = cartItems.some(function (item) {
      return item.province === destination && item.delivery_type !== 'pickup';
    });
    checkoutLocalContactsReady = !hasDestinationDelivery;
    list.querySelectorAll('.checkout-item-local-contact').forEach(function (row) { row.remove(); });
    updateCheckoutAvailability();
    try {
      const result = await api('/api/cart?deliveryProvince=' + encodeURIComponent(destination));
      if (requestId !== checkoutContactRequest || province.value !== destination) return;
      const items = new Map(result.items.map(function (item) { return [String(item.product_id), item]; }));
      let missingLocalContact = false;
      list.querySelectorAll('.cart-item').forEach(function (line) {
        const item = items.get(line.dataset.productId);
        if (!item) return;
        const cartItem = cartItems.find(function (entry) { return String(entry.product_id) === line.dataset.productId; });
        if (cartItem) cartItem.delivery_contact = item.delivery_contact;
        if (item.province === destination && item.delivery_type !== 'pickup' && !item.delivery_contact) {
          missingLocalContact = true;
        }
        const fulfillment = line.querySelector('.checkout-item-fulfillment');
        if (fulfillment) appendCheckoutLocalContact(fulfillment, item);
      });
      checkoutLocalContactsReady = !missingLocalContact;
      updateCheckoutAvailability();
    } catch (error) {
      if (requestId !== checkoutContactRequest) return;
      checkoutLocalContactsReady = !hasDestinationDelivery;
      updateCheckoutAvailability();
      const status = document.getElementById('freightQuoteStatus');
      if (hasDestinationDelivery && status) status.textContent = 'Could not load the local driver/skipper contact. Retry checkout before placing your order.';
    }
  }

  function renderVendorCheckoutMethods() {
    const list = document.getElementById('paymentMethods');
    if (!list) return;
    const button = document.getElementById('placeOrderButton');
    list.replaceChildren();
    const vendors = new Map();
    cartItems.forEach(function (item) {
      const vendorId = String(item.vendor_id);
      if (!vendors.has(vendorId)) {
        vendors.set(vendorId, {
          name: item.business_name || 'Vendor',
          methods: Array.isArray(item.payment_methods) ? item.payment_methods : []
        });
      }
    });
    paymentMethodReady = vendors.size > 0 && Array.from(vendors.values()).every(function (vendor) {
      return vendor.methods.some(function (method) {
        return method && typeof method.id === 'string' &&
          vendorPaymentChoices.some(function (choice) { return choice.id === method.id; }) &&
          typeof method.name === 'string' && typeof method.instructions === 'string' && method.instructions.trim().length > 0;
      });
    });
    if (!vendors.size) {
      list.textContent = 'Add products to your cart to see each business’s payment methods.';
    } else {
      vendors.forEach(function (vendor, vendorId) {
        const fieldset = document.createElement('fieldset');
        fieldset.className = 'vendor-checkout-payment';
        const legend = document.createElement('legend');
        legend.textContent = vendor.name;
        fieldset.appendChild(legend);
        const validMethods = vendor.methods.filter(function (method) {
          return method && typeof method.id === 'string' &&
            vendorPaymentChoices.some(function (choice) { return choice.id === method.id; }) &&
            typeof method.name === 'string' && typeof method.instructions === 'string' && method.instructions.trim().length > 0;
        });
        if (!validMethods.length) {
          const empty = document.createElement('p');
          empty.textContent = 'This business has not configured a payment method. Checkout is unavailable until it does.';
          fieldset.appendChild(empty);
        }
        validMethods.forEach(function (method, index) {
          const label = document.createElement('label');
          label.className = 'option-card';
          const details = document.createElement('span');
          const name = document.createElement('strong');
          name.textContent = method.name;
          details.appendChild(name);
          if (typeof method.instructions === 'string' && method.instructions) {
            const instructions = document.createElement('span');
              instructions.className = 'muted vendor-payment-details';
            instructions.textContent = method.instructions;
            details.appendChild(instructions);
          }
          appendPaymentReferenceContacts(details, method.referencePhone, method.referenceWhatsapp);
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = 'paymentMethod-' + vendorId;
          input.value = method.id;
          input.required = true;
          input.dataset.vendorId = vendorId;
          input.checked = index === 0;
          label.append(details, input);
          fieldset.appendChild(label);
        });
        list.appendChild(fieldset);
      });
    }
    const status = document.getElementById('paymentMethodStatus');
    if (status && vendors.size) {
      status.textContent = paymentMethodReady
        ? 'Select one listed method for every business. Payment stays pending until the relevant vendor confirms receipt.'
        : 'At least one business in your cart has not configured payment options. Checkout is unavailable; contact that business or remove its items.';
    } else if (status) {
      status.textContent = 'Add products to your cart to see each business’s payment options.';
    }
    if (button) button.textContent = 'Place vendor orders';
    updateCheckoutAvailability();
  }

  async function refreshFreightEstimate() {
    const status = document.getElementById('freightQuoteStatus');
    const shippingNode = document.getElementById('shippingEstimate');
    const totalNode = document.getElementById('totalValue');
    if (!status || !shippingNode || !totalNode) return;
    const requestId = ++freightQuoteRequest;
    freightQuoteReady = false;
    const province = document.getElementById('deliveryProvince');
    updateShippingProviderAvailability();
    const provider = document.querySelector('input[name="carrierMethod"]:checked');
    const vendorOrigins = new Map();
    cartItems.forEach(function (item) {
      const vendorId = String(item.vendor_id);
      if (!vendorOrigins.has(vendorId)) vendorOrigins.set(vendorId, new Set());
      vendorOrigins.get(vendorId).add(item.province);
    });
    shippingNode.textContent = 'Not estimated';
    totalNode.textContent = 'Calculated at checkout';
    const localDeliveryContactMissing = province && cartItems.some(function (item) {
      return item.province === province.value &&
        item.delivery_type !== 'pickup' && item.local_delivery_available !== true;
    });
    if (localDeliveryContactMissing && (!provider || provider.value === 'PMV')) {
      status.textContent = 'A vendor has not added the required local driver/skipper contact for this province. Ask the vendor to update the listing or choose pickup if available.';
      updateCheckoutAvailability();
      return;
    }
    if (cartItems.length && !Array.from(document.querySelectorAll('input[name="carrierMethod"]')).some(function (option) {
      return !option.disabled;
    })) {
      const origins = new Set(cartItems.map(function (item) { return item.province; }));
      const mixedRoute = province && province.value && origins.size &&
        Array.from(origins).some(function (origin) { return origin === province.value; }) &&
        Array.from(origins).some(function (origin) { return origin !== province.value; });
      status.textContent = mixedRoute
        ? 'This cart includes both within-province and inter-province routes. Place those items in separate orders.'
        : 'Choose PMV or pickup within the same province, or ship/air freight when all products come from another province.';
      updateCheckoutAvailability();
      return;
    }
    if (!cartItems.length || !province || !province.value || !provider || !vendorOrigins.size) {
      status.textContent = 'Select a delivery province and an available carrier to check configured freight rates.';
      updateCheckoutAvailability();
      return;
    }
    status.textContent = 'Checking configured freight rates...';
    updateCheckoutAvailability();
    try {
      const quotes = await Promise.all(Array.from(vendorOrigins.values()).map(function (origins) {
        return api('/api/freight/estimate', {
          method: 'POST',
          body: JSON.stringify({
            originProvinces: Array.from(origins),
            destinationProvince: province.value,
            provider: provider.value
          })
        });
      }));
      if (requestId !== freightQuoteRequest) return;
      if (quotes.some(function (quote) {
        return !Number.isFinite(Number(quote.amountKina)) || Number(quote.amountKina) < 0 || typeof quote.isEstimate !== 'boolean';
      })) {
        throw new Error('The server returned an invalid freight quote.');
      }
      const subtotal = cartItems.reduce(function (sum, item) {
        return sum + Math.round(Number(item.price_kina) * 100) * Number(item.quantity);
      }, 0);
      const freight = quotes.reduce(function (sum, quote) {
        return sum + Math.round(Number(quote.amountKina) * 100);
      }, 0);
      const shippingPayer = document.querySelector('input[name="shippingPayer"]:checked');
      const isEstimate = quotes.some(function (quote) { return quote.isEstimate; });
      freightQuoteReady = true;
      shippingNode.textContent = money(freight / 100) + (isEstimate ? ' (estimate)' : '') +
        (shippingPayer ? ' · ' + (shippingPayer.value === 'vendor' ? 'vendor pays' : 'buyer pays') : '');
      totalNode.textContent = money((subtotal + (shippingPayer && shippingPayer.value === 'vendor' ? 0 : freight)) / 100);
      status.textContent = 'Freight is calculated from configured rates and will be rechecked when you place the order.';
      updateCheckoutAvailability();
    } catch (error) {
      if (requestId !== freightQuoteRequest) return;
      freightQuoteReady = false;
      status.textContent = error.message;
      updateCheckoutAvailability();
    }
  }

  async function loadOrderHistory() {
    const container = document.getElementById('orderHistory');
    if (!container) return;
    if (!currentUser) {
      if (sessionError) container.textContent = sessionError.message;
      return;
    }
    try {
      const result = await api('/api/orders');
      container.replaceChildren();
      if (!result.orders.length) {
        container.textContent = 'No orders yet.';
        return;
      }
      result.orders.forEach(function (order) {
        const row = document.createElement('article');
        row.className = 'cart-item';
        const summary = document.createElement('div');
        summary.className = 'item-meta';
        const title = document.createElement('strong');
        const orderLink = document.createElement('a');
        orderLink.href = 'order-detail.html?id=' + encodeURIComponent(order.order_id);
        orderLink.textContent = `Order #${order.order_id} · ${order.order_status}`;
        title.appendChild(orderLink);
        const details = document.createElement('small');
        details.textContent = `${order.payment_status}${order.vendor_confirmed_receipt ? ' (vendor confirmed receipt; not provider-verified)' : ''} · ${paymentMethodLabel(order.payment_method)} · ${provinceLabel(order.delivery_province)} · ${order.shipping_payer === 'vendor' ? 'Vendor pays delivery' : 'Buyer pays delivery'} · ${order.items.length} item(s)`;
        summary.append(title, details);
        const total = document.createElement('strong');
        total.textContent = money(order.total_kina);
        row.append(summary, total);
        container.appendChild(row);
      });
    } catch (error) {
      container.textContent = error.message;
    }
  }

  function bindCheckout() {
    const button = document.getElementById('placeOrderButton');
    if (!button) return;
    button.addEventListener('click', async function () {
      const tracker = document.getElementById('orderTracker');
      if (!currentUser) {
        window.location.href = 'login.html?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search);
        return;
      }
      const address = document.getElementById('deliveryAddress');
      const province = document.getElementById('deliveryProvince');
      const phone = document.getElementById('deliveryPhone');
      if (!address.reportValidity() || !province.reportValidity() || !phone.reportValidity()) return;
      const selectedProvider = document.querySelector('input[name="carrierMethod"]:checked');
      const selectedShippingPayer = document.querySelector('input[name="shippingPayer"]:checked');
      const selectedPayments = Array.from(document.querySelectorAll('#paymentMethods input[type="radio"]:checked'));
      if (!selectedProvider || !selectedShippingPayer || !selectedPayments.length) {
        if (tracker) tracker.textContent = 'Choose a shipping provider, who pays for delivery, and one payment option for every business.';
        return;
      }
      button.disabled = true;
      if (tracker) tracker.textContent = 'Validating stock and configured delivery estimates...';
      try {
        const checkout = {
          deliveryAddress: document.getElementById('deliveryAddress').value,
          deliveryProvince: document.getElementById('deliveryProvince').value,
          phoneNumber: document.getElementById('deliveryPhone').value,
          shippingProvider: selectedProvider.value,
          shippingPayer: selectedShippingPayer.value,
          vendorPaymentMethods: selectedPayments.map(function (input) {
            return { vendorId: input.dataset.vendorId, methodId: input.value };
          })
        };
        const cartFingerprint = cartItems.map(function (item) {
          return [String(item.vendor_id), String(item.product_id), Number(item.quantity)];
        }).sort(function (a, b) {
          return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
        });
        const fingerprint = JSON.stringify([checkout, cartFingerprint]);
        const savedAttempt = window.sessionStorage.getItem('kundu-checkout-attempt');
        let attempt;
        try { attempt = savedAttempt ? JSON.parse(savedAttempt) : null; }
        catch (error) { attempt = null; }
        if (!attempt || attempt.fingerprint !== fingerprint || !attempt.key) {
          attempt = { fingerprint, key: window.crypto.randomUUID() };
          window.sessionStorage.setItem('kundu-checkout-attempt', JSON.stringify(attempt));
        }
        const result = await api('/api/checkout', {
          method: 'POST',
          headers: { 'Idempotency-Key': attempt.key },
          body: JSON.stringify(checkout)
        });
        window.sessionStorage.removeItem('kundu-checkout-attempt');
        const orderIds = result.orders.map(function (order) { return String(order.order_id); });
        if (tracker) tracker.textContent = result.orders.length > 1
          ? `${result.orders.length} separate vendor orders created. Each payment remains pending until its vendor confirms receipt.`
          : `Vendor order #${orderIds[0]} created. Payment remains pending until the vendor confirms receipt.`;
        window.location.assign('order-confirmation.html?ids=' + encodeURIComponent(orderIds.join(',')));
      } catch (error) {
        if (tracker) tracker.textContent = error.message;
      } finally { updateCheckoutAvailability(); }
    });
    const address = document.getElementById('deliveryAddress');
    const province = document.getElementById('deliveryProvince');
    const phone = document.getElementById('deliveryPhone');
    [address, province, phone].filter(Boolean).forEach(function (input) {
      input.addEventListener('input', updateCheckoutAvailability);
      input.addEventListener('change', updateCheckoutAvailability);
    });
    const paymentMethods = document.getElementById('paymentMethods');
    if (paymentMethods) paymentMethods.addEventListener('change', updateCheckoutAvailability);
    document.querySelectorAll('input[name="carrierMethod"]').forEach(function (input) {
      input.addEventListener('change', updateCheckoutAvailability);
    });
    document.querySelectorAll('input[name="shippingPayer"]').forEach(function (input) {
      input.addEventListener('change', function () {
        updateCheckoutAvailability();
        refreshFreightEstimate();
      });
    });
    updateCheckoutAvailability();
  }

  async function loadProductDetail() {
    if (!document.getElementById('detailName')) return;
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
      const add = document.getElementById('addToCartBtn');
      if (add) add.disabled = true;
      const status = document.getElementById('detailStatus');
      if (status) status.textContent = 'Choose a product from the marketplace to view its details.';
      return;
    }
    try {
      const result = await api('/api/products/' + encodeURIComponent(id));
      const product = result.product;
      const title = document.getElementById('detailName');
      if (title) title.textContent = text(product.product_name);
      document.title = text(product.product_name) + ' | KEDOLAKA MARKET';
      const price = document.getElementById('detailPrice');
      if (price) price.textContent = money(product.price_kina) + (product.price_unit ? ' / ' + text(product.price_unit) : '');
      const description = document.getElementById('detailDescription');
      if (description) description.textContent = text(product.description);
      const stock = document.getElementById('detailStock');
      if (stock) stock.textContent = text(product.stock_quantity) + ' available';
      const location = document.getElementById('detailProvince');
      if (location) location.textContent = provinceLabel(product.province);
      const delivery = document.getElementById('detailDelivery');
      if (delivery) delivery.textContent = deliveryTypeLabel(product.delivery_type);
      const condition = document.getElementById('detailCondition');
      if (condition) condition.textContent = ({ new: 'New', used: 'Used', refurbished: 'Refurbished' })[product.item_condition] || text(product.item_condition);
      const priceUnit = document.getElementById('detailPriceUnit');
      if (priceUnit) priceUnit.textContent = text(product.price_unit);
      const deliveryNotesSection = document.getElementById('detailDeliveryNotesSection');
      const deliveryNotes = document.getElementById('detailDeliveryNotes');
      if (deliveryNotesSection && deliveryNotes) {
        deliveryNotes.textContent = text(product.delivery_notes);
        deliveryNotesSection.hidden = !product.delivery_notes;
      }
      const additionalDetailsSection = document.getElementById('detailAdditionalDetailsSection');
      const additionalDetailsList = document.getElementById('detailAdditionalDetails');
      if (additionalDetailsSection && additionalDetailsList) {
        const labels = {
          brand: 'Brand or manufacturer',
          model: 'Model or SKU',
          dimensions: 'Size, dimensions, or weight',
          materials: 'Materials or ingredients',
          origin: 'Country or province of origin',
          warranty: 'Warranty and returns',
          deliveryAreas: 'Areas or provinces served',
          dispatchTime: 'Preparation or dispatch time',
          deliveryEstimate: 'Estimated delivery time',
          pickupDetails: 'Pickup location and arrangements',
          deliveryRestrictions: 'Delivery restrictions'
        };
        additionalDetailsList.replaceChildren();
        Object.keys(labels).forEach(function (field) {
          const value = product.additional_details && product.additional_details[field];
          if (!value) return;
          const term = document.createElement('dt');
          term.textContent = labels[field];
          const description = document.createElement('dd');
          description.textContent = text(value);
          additionalDetailsList.append(term, description);
        });
        additionalDetailsSection.hidden = !additionalDetailsList.childElementCount;
      }
      const seller = document.getElementById('detailVendor');
      if (seller) seller.textContent = text(product.business_name);
      const category = document.getElementById('detailCategory');
      if (category) category.textContent = text(product.category);
      const approvedBadge = document.getElementById('detailApprovedBadge');
      if (approvedBadge) approvedBadge.hidden = false;
      const imageHost = document.getElementById('detailImage');
      if (imageHost && product.image_url) {
        const image = document.createElement('img');
        image.src = product.image_url;
        image.alt = text(product.product_name);
        image.addEventListener('error', function () {
          imageHost.textContent = 'Image unavailable';
        }, { once: true });
        imageHost.replaceChildren(image);
      }
      const add = document.getElementById('addToCartBtn');
      if (add) add.disabled = Number(product.stock_quantity) < 1;
      if (add) add.addEventListener('click', async function () {
        if (!currentUser) {
          window.location.href = 'login.html?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search);
          return;
        }
        try {
          add.disabled = true;
          await api('/api/cart/items/' + encodeURIComponent(product.product_id), { method: 'POST' });
          await refreshCartCount();
          add.textContent = 'Added to Cart';
        } catch (error) {
          const status = document.getElementById('detailStatus');
          if (status) status.textContent = error.message;
        } finally {
          add.disabled = false;
        }
      });
    } catch (error) {
      const title = document.getElementById('detailName');
      if (title) title.textContent = 'Product unavailable';
      const status = document.getElementById('detailStatus');
      if (status) status.textContent = error.message;
    }
  }

  async function loadOrderDetail() {
    const detail = document.getElementById('orderDetail');
    if (!detail) return;
    if (!currentUser) {
      window.location.assign('login.html?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search));
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const ids = (params.get('ids') || '').split(',').filter(Boolean);
    const checkoutOrders = document.getElementById('checkoutOrders');
    if (ids.length && checkoutOrders) {
      if (ids.length > 50 || ids.some(function (value) { return !/^[1-9]\d*$/.test(value); })) {
        const loading = document.getElementById('orderLoading');
        if (loading) loading.textContent = 'One or more order IDs are invalid.';
        return;
      }
      try {
        const results = await Promise.all(ids.map(function (orderId) {
          return api('/api/orders/' + encodeURIComponent(orderId));
        }));
        checkoutOrders.replaceChildren();
        results.forEach(function (result) {
          const order = result.order;
          const card = document.createElement('article');
          card.className = 'order-panel checkout-confirmation-order';
          const heading = document.createElement('h2');
          heading.textContent = 'Order #' + order.order_id;
          const status = document.createElement('p');
          status.textContent = order.vendor_confirmed_receipt
            ? 'Payment status: vendor confirmed receipt; not independently verified by a payment provider.'
            : 'Payment status: ' + order.payment_status +
              (order.payment_status === 'pending' ? ' — awaiting the vendor’s confirmation of receipt.' : '.');
          const method = document.createElement('p');
          method.textContent = 'Payment method: ' + paymentMethodLabel(order.payment_method);
          const instructions = document.createElement('p');
          instructions.className = 'vendor-payment-details';
          instructions.textContent = order.payment_instructions || 'Contact the vendor for payment instructions.';
          const paymentDetails = document.createElement('div');
          appendPaymentReferenceContacts(paymentDetails, order.payment_reference_phone, order.payment_reference_whatsapp);
          const total = document.createElement('p');
          total.textContent = 'Total: ' + money(order.total_kina);
          const link = document.createElement('a');
          link.href = 'order-detail.html?id=' + encodeURIComponent(order.order_id);
          link.textContent = 'View order details';
          const contacts = document.createElement('div');
          order.items.forEach(function (item) {
            if (!item.deliveryContact) return;
            const contactRow = document.createElement('p');
            contactRow.textContent = item.name + ' · ' + provinceLabel(item.deliveryContact.province) + ' · ';
            appendDeliveryContact(contactRow, item.deliveryContact);
            contacts.appendChild(contactRow);
          });
          card.append(heading, status, method, instructions, paymentDetails, contacts, total, link);
          checkoutOrders.appendChild(card);
        });
        const loading = document.getElementById('orderLoading');
        if (loading) loading.hidden = true;
        ['orderTitle', 'orderStatus', 'orderTotal', 'orderActionStatus', 'cancelOrderButton', 'orderPaymentLink'].forEach(function (id) {
          const node = document.getElementById(id);
          if (node) node.hidden = true;
        });
        return;
      } catch (error) {
        const loading = document.getElementById('orderLoading');
        if (loading) loading.textContent = error.message;
        return;
      }
    }
    const id = params.get('id');
    if (!id) {
      detail.textContent = 'An order number is required.';
      return;
    }
    try {
      const result = await api('/api/orders/' + encodeURIComponent(id));
      const order = result.order;
      const loading = document.getElementById('orderLoading');
      if (loading) loading.hidden = true;
        const orderTitle = document.getElementById('orderTitle');
        const orderStatus = document.getElementById('orderStatus');
        if (orderTitle) orderTitle.textContent = 'Order #' + order.order_id;
        if (orderStatus) orderStatus.textContent = 'Order status: ' + order.order_status +
          (order.vendor_confirmed_receipt ? ' · vendor confirmed receipt; not independently provider-verified' : '');
        const paymentLink = document.getElementById('orderPaymentLink');
        if (paymentLink) paymentLink.href = 'payment-status.html?id=' + encodeURIComponent(order.order_id);
        const orderDelivery = document.getElementById('orderDelivery');
        const orderFreight = document.getElementById('orderFreight');
        const orderShipment = document.getElementById('orderShipment');
        const orderRefunds = document.getElementById('orderRefunds');
        const orderTotal = document.getElementById('orderTotal');
        if (orderDelivery) orderDelivery.textContent = `${order.delivery_address}, ${provinceLabel(order.delivery_province)} · ${order.phone_number}`;
        if (orderFreight) orderFreight.textContent = `${order.shipping_provider}: ${money(order.shipping_kina)}${order.freight_is_estimate ? ' (estimate)' : ''} · ${order.shipping_payer === 'vendor' ? 'Vendor pays' : 'Buyer pays'}`;
        if (orderShipment) {
          orderShipment.replaceChildren();
          if (order.shipment_carrier || order.shipment_booking_reference || order.shipment_tracking_reference ||
              order.shipment_driver_name || order.shipment_vehicle_plate) {
            orderShipment.appendChild(document.createTextNode([
              'Shipment: ' + (order.shipment_carrier || order.shipping_provider),
              order.shipment_booking_reference ? 'Booking ' + order.shipment_booking_reference : '',
              order.shipment_tracking_reference ? 'Tracking ' + order.shipment_tracking_reference : '',
              order.shipment_driver_name ? 'Driver ' + order.shipment_driver_name : '',
              order.shipment_driver_phone ? order.shipment_driver_phone : '',
              order.shipment_vehicle_plate ? 'Plate ' + order.shipment_vehicle_plate : '',
              order.shipment_vehicle_description ? order.shipment_vehicle_description : ''
            ].filter(Boolean).join(' · ')));
            if (order.shipment_tracking_url) {
              const trackingLink = document.createElement('a');
              trackingLink.href = order.shipment_tracking_url;
              trackingLink.target = '_blank';
              trackingLink.rel = 'noopener noreferrer';
              trackingLink.textContent = 'Track shipment';
              orderShipment.append(' ', trackingLink);
            }
            if (order.shipment_notes) orderShipment.append(document.createElement('br'), document.createTextNode(order.shipment_notes));
          } else {
            orderShipment.textContent = 'Shipment tracking has not been added yet.';
          }
        }
        if (orderRefunds) {
          orderRefunds.textContent = Number(order.refunded_kina) > 0
            ? 'Manually recorded refunds: ' + money(order.refunded_kina) + '. Contact support if you have questions.'
            : '';
        }
        if (orderTotal) orderTotal.textContent = `Subtotal ${money(order.subtotal_kina)} · Total ${money(order.total_kina)}`;
        const paymentMethod = document.getElementById('orderPaymentMethod');
        const paymentInstructions = document.getElementById('orderPaymentInstructions');
        if (paymentMethod) paymentMethod.textContent = 'Method: ' + paymentMethodLabel(order.payment_method) + ' · Payment status: ' + order.payment_status;
        if (paymentInstructions) paymentInstructions.textContent = order.payment_instructions || 'Contact the vendor for payment instructions.';
        const paymentReferenceContacts = document.getElementById('orderPaymentReferenceContacts');
        if (paymentReferenceContacts) {
          paymentReferenceContacts.replaceChildren();
          appendPaymentReferenceContacts(paymentReferenceContacts, order.payment_reference_phone, order.payment_reference_whatsapp);
        }
        const items = document.getElementById('orderItems');
        if (items) {
          items.replaceChildren();
          order.items.forEach(function (item) {
            const row = document.createElement('li');
            row.textContent = `${item.name} · ${item.quantity} × ${money(item.unitPriceKina)}`;
            appendDeliveryContact(row, item.deliveryContact);
            items.appendChild(row);
          });
        }
      const cancelButton = document.getElementById('cancelOrderButton');
      if (cancelButton && order.payment_status === 'pending' && order.order_status === 'pending') {
        cancelButton.hidden = false;
        cancelButton.addEventListener('click', async function () {
          cancelButton.disabled = true;
          const status = document.getElementById('orderActionStatus');
          try {
            await api('/api/orders/' + encodeURIComponent(order.order_id) + '/cancel', { method: 'POST' });
            if (status) status.textContent = 'Order cancelled and reserved stock released.';
            window.location.reload();
          } catch (error) {
            if (status) status.textContent = error.message;
            cancelButton.disabled = false;
          }
        }, { once: true });
      }
    } catch (error) {
      const loading = document.getElementById('orderLoading');
      if (loading) loading.textContent = error.message;
    }
  }

  async function initAdminWorkspace() {
    const workspace = document.getElementById('adminWorkspace');
    if (!workspace) return;
    const message = document.getElementById('adminMessage');
    if (!currentUser || currentUser.role !== 'admin') {
      showMessage(message, 'Administrator access is required to view this workspace.', 'error');
      return;
    }

    const vendorsNode = document.getElementById('adminVendors');
    const productsNode = document.getElementById('adminProducts');
    const ratesNode = document.getElementById('adminFreightRates');
    const ordersNode = document.getElementById('adminOrders');
    const paymentsNode = document.getElementById('adminPayments');
    const activityNode = document.getElementById('adminActivity');
    let analyticsNode = document.getElementById('adminAnalytics');
    if (!analyticsNode) {
      analyticsNode = document.createElement('section');
      analyticsNode.id = 'adminAnalytics';
      analyticsNode.setAttribute('aria-label', 'Marketplace analytics');
      message.insertAdjacentElement('afterend', analyticsNode);
    }

    function makeRow(primary, secondary) {
      const row = document.createElement('li');
      row.className = 'admin-row';
      const details = document.createElement('div');
      const heading = document.createElement('strong');
      heading.textContent = primary;
      const subheading = document.createElement('p');
      subheading.textContent = secondary;
      details.append(heading, subheading);
      row.appendChild(details);
      return row;
    }

    function empty(node, messageText) {
      if (!node) return;
      node.replaceChildren();
      const row = document.createElement('li');
      row.textContent = messageText;
      node.appendChild(row);
    }

    async function setVendorStatus(vendor, status) {
      await api('/api/admin/vendors/' + encodeURIComponent(vendor.vendor_id) + '/status', {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      await refresh();
    }

    async function refresh() {
      const result = await api('/api/admin/dashboard');
      showMessage(message, 'Administrator workspace loaded from current database records.', 'success');
      const vendorCount = document.getElementById('adminVendorCount');
      const productCount = document.getElementById('adminProductCount');
      const orderCount = document.getElementById('adminOrderCount');
      const paymentCount = document.getElementById('adminPaymentCount');
      if (vendorCount) vendorCount.textContent = text(result.vendors.length);
      if (productCount) productCount.textContent = text(result.products.length);
      if (orderCount) orderCount.textContent = text(result.orders.length);
      if (paymentCount) paymentCount.textContent = text(result.payments.length);
      if (analyticsNode && result.analytics) {
        analyticsNode.replaceChildren();
        [
          ['Orders today', result.analytics.orders_today],
          ['Orders, last 30 days', result.analytics.orders_last_30_days],
          ['Active orders', result.analytics.active_orders],
          ['Vendors awaiting review', result.analytics.pending_vendors],
          ['Listed products', result.analytics.listed_products],
          ['Net recorded revenue', money(result.analytics.net_recorded_revenue_kina)]
        ].forEach(function (metric) {
          const item = document.createElement('p');
          const label = document.createElement('span');
          label.textContent = metric[0];
          const value = document.createElement('strong');
          value.textContent = text(metric[1]);
          item.append(label, value);
          analyticsNode.appendChild(item);
        });
      }

      if (vendorsNode) vendorsNode.replaceChildren();
      if (vendorsNode && !result.vendors.length) empty(vendorsNode, 'No vendor applications or profiles.');
      result.vendors.forEach(function (vendor) {
        if (!vendorsNode) return;
        const row = makeRow(
          vendor.business_name || 'Vendor application',
          `${vendor.full_name} · ${vendor.email} · ${provinceLabel(vendor.province)} · ${vendor.status}`
        );
        const actions = document.createElement('div');
        actions.className = 'admin-actions';
        [
          { label: 'Approve', status: 'active' },
          { label: 'Reject', status: 'rejected' },
          { label: 'Suspend', status: 'suspended' },
          { label: 'Return to review', status: 'review' }
        ].forEach(function (action) {
          if (vendor.status === action.status) return;
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = action.label;
          button.addEventListener('click', async function () {
            button.disabled = true;
            try { await setVendorStatus(vendor, action.status); }
            catch (error) { showMessage(message, error.message, 'error'); button.disabled = false; }
          });
          actions.appendChild(button);
        });
        row.appendChild(actions);
        vendorsNode.appendChild(row);
      });

      if (productsNode) productsNode.replaceChildren();
      if (productsNode && !result.products.length) empty(productsNode, 'No products in the database.');
      result.products.forEach(function (product) {
        if (!productsNode) return;
        const row = makeRow(
          product.product_name,
          `${product.business_name || 'Vendor'} · ${product.category} · ${provinceLabel(product.province)} · ${money(product.price_kina)} · ${product.stock_quantity} in stock · ${product.status}`
        );
        const actions = document.createElement('div');
        actions.className = 'admin-actions';
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Publication status for ' + product.product_name);
        ['listed', 'paused', 'out_of_stock'].forEach(function (status) {
          select.add(new Option(status.replace('_', ' '), status));
        });
        select.value = product.status;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Update status';
        button.addEventListener('click', async function () {
          button.disabled = true;
          try {
            await api('/api/admin/products/' + encodeURIComponent(product.product_id) + '/status', {
              method: 'PATCH',
              body: JSON.stringify({ status: select.value })
            });
            await refresh();
          } catch (error) { showMessage(message, error.message, 'error'); button.disabled = false; }
        });
        actions.append(select, button);
        row.appendChild(actions);
        productsNode.appendChild(row);
      });

      if (ratesNode) ratesNode.replaceChildren();
      if (ratesNode && !result.freightRates.length) empty(ratesNode, 'No freight routes are configured.');
      result.freightRates.forEach(function (rate) {
        if (!ratesNode) return;
        const row = makeRow(
          `${rate.origin_province} to ${rate.destination_province} · ${rate.provider}`,
          `${money(rate.amount_kina)} ${rate.is_estimate ? '(estimate)' : '(configured rate)'} · ${rate.active ? 'active' : 'inactive'}`
        );
        ratesNode.appendChild(row);
      });

      if (ordersNode) ordersNode.replaceChildren();
      if (ordersNode && !result.orders.length) empty(ordersNode, 'No orders are recorded.');
      result.orders.forEach(function (order) {
        if (!ordersNode) return;
        const row = makeRow(
          `Order #${order.order_id} · ${order.order_status}`,
          `${order.buyer_name} · ${order.buyer_email} · ${order.payment_status} · ${provinceLabel(order.delivery_province)} · ${money(order.total_kina)} · refunded ${money(order.refunded_kina)} · ${new Date(order.created_at).toLocaleString()}`
        );
        const editForm = document.createElement('form');
        editForm.className = 'admin-order-edit';
        [
          ['deliveryAddress', 'Delivery address', order.delivery_address, 500],
          ['deliveryProvince', 'Delivery province', order.delivery_province, 120],
          ['phoneNumber', 'Buyer phone', order.phone_number, 30],
          ['shippingProvider', 'Shipping method', order.shipping_provider, 40]
        ].forEach(function (field) {
          const label = document.createElement('label');
          label.textContent = field[1];
          const input = document.createElement('input');
          input.name = field[0];
          input.maxLength = field[3];
          input.value = field[2] || '';
          label.appendChild(input);
          editForm.appendChild(label);
        });
        const saveOrder = document.createElement('button');
        saveOrder.type = 'submit';
        saveOrder.textContent = 'Save delivery details';
        editForm.appendChild(saveOrder);
        editForm.addEventListener('submit', async function (event) {
          event.preventDefault();
          saveOrder.disabled = true;
          try {
            await api('/api/admin/orders/' + encodeURIComponent(order.order_id), {
              method: 'PATCH',
              body: JSON.stringify(Object.fromEntries(new FormData(editForm).entries()))
            });
            await refresh();
          } catch (error) {
            showMessage(message, error.message, 'error');
            saveOrder.disabled = false;
          }
        });
        row.appendChild(editForm);
        if (order.payment_status === 'successful') {
          const refundForm = document.createElement('form');
          refundForm.className = 'admin-order-refund';
          const refundable = Math.max(0, Number(order.total_kina) - Number(order.refunded_kina));
          const refundAmount = document.createElement('input');
          refundAmount.name = 'amountKina';
          refundAmount.type = 'number';
          refundAmount.min = '0.01';
          refundAmount.max = refundable.toFixed(2);
          refundAmount.step = '0.01';
          refundAmount.required = true;
          refundAmount.setAttribute('aria-label', 'Refund amount for order ' + order.order_id);
          refundAmount.placeholder = 'Amount (PGK)';
          const refundMethod = document.createElement('select');
          refundMethod.name = 'refundMethod';
          refundMethod.setAttribute('aria-label', 'Refund method for order ' + order.order_id);
          [['bank_transfer', 'Bank transfer'], ['mobile_wallet', 'Mobile wallet'], ['cash', 'Cash'], ['other', 'Other']]
            .forEach(function (choice) { refundMethod.add(new Option(choice[1], choice[0])); });
          const refundReference = document.createElement('input');
          refundReference.name = 'reference';
          refundReference.maxLength = 120;
          refundReference.placeholder = 'Reference (optional)';
          refundReference.setAttribute('aria-label', 'Refund reference for order ' + order.order_id);
          const refundReason = document.createElement('input');
          refundReason.name = 'reason';
          refundReason.minLength = 3;
          refundReason.maxLength = 500;
          refundReason.required = true;
          refundReason.placeholder = 'Reason';
          refundReason.setAttribute('aria-label', 'Refund reason for order ' + order.order_id);
          const refundButton = document.createElement('button');
          refundButton.type = 'submit';
          refundButton.textContent = 'Record manual refund';
          refundForm.append(refundAmount, refundMethod, refundReference, refundReason, refundButton);
          refundForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            if (!window.confirm('Record this offline refund? This does not transfer money.')) return;
            refundButton.disabled = true;
            const data = new FormData(refundForm);
            try {
              await api('/api/admin/orders/' + encodeURIComponent(order.order_id) + '/refunds', {
                method: 'POST',
                body: JSON.stringify({
                  amountKina: Number(data.get('amountKina')), refundMethod: data.get('refundMethod'),
                  reference: data.get('reference'), reason: data.get('reason')
                })
              });
              await refresh();
            } catch (error) {
              showMessage(message, error.message, 'error');
              refundButton.disabled = false;
            }
          });
          const refundWarning = document.createElement('small');
          refundWarning.textContent = 'Manual record only; transfer funds outside the marketplace.';
          row.append(refundForm, refundWarning);
        }
        ordersNode.appendChild(row);
      });

      if (paymentsNode) paymentsNode.replaceChildren();
      if (paymentsNode && !result.payments.length) empty(paymentsNode, 'No pending manual payments need verification.');
      result.payments.forEach(function (payment) {
        if (!paymentsNode) return;
        const row = makeRow(
          `Order #${payment.order_id} · ${payment.payment_method}`,
          `${money(payment.total_kina)} · ${provinceLabel(payment.delivery_province)} · expires ${new Date(payment.expires_at).toLocaleString()}`
        );
        const actions = document.createElement('div');
        actions.className = 'admin-actions';
        const reference = document.createElement('input');
        reference.type = 'text';
        reference.maxLength = 120;
        reference.placeholder = 'Verified receipt reference';
        reference.setAttribute('aria-label', 'Independently verified receipt reference for order ' + payment.order_id);
        const success = document.createElement('button');
        success.type = 'button';
        success.textContent = 'Confirm receipt';
        success.addEventListener('click', async function () {
          if (!reference.value.trim() || !window.confirm('Confirm that you independently verified receipt of the exact PGK order amount in the merchant bank or in-person records?')) return;
          success.disabled = true;
          try {
            await api('/api/admin/payments/' + encodeURIComponent(payment.payment_id) + '/verify', {
              method: 'POST',
              body: JSON.stringify({ status: 'successful', verificationReference: reference.value.trim() })
            });
            await refresh();
          } catch (error) { showMessage(message, error.message, 'error'); success.disabled = false; }
        });
        const failed = document.createElement('button');
        failed.type = 'button';
        failed.textContent = 'Mark not received';
        failed.addEventListener('click', async function () {
          const reason = window.prompt('Record why receipt was not verified:');
          if (!reason || reason.trim().length < 3) return;
          failed.disabled = true;
          try {
            await api('/api/admin/payments/' + encodeURIComponent(payment.payment_id) + '/verify', {
              method: 'POST',
              body: JSON.stringify({ status: 'failed', failureReason: reason.trim() })
            });
            await refresh();
          } catch (error) { showMessage(message, error.message, 'error'); failed.disabled = false; }
        });
        actions.append(reference, success, failed);
        row.appendChild(actions);
        paymentsNode.appendChild(row);
      });

      if (activityNode) activityNode.replaceChildren();
      if (activityNode && !result.activity.length) empty(activityNode, 'No administrative actions recorded.');
      result.activity.forEach(function (entry) {
        if (!activityNode) return;
        activityNode.appendChild(makeRow(
          `${entry.action} · ${entry.resource_type} ${entry.resource_id || ''}`,
          `${entry.admin_email} · ${new Date(entry.created_at).toLocaleString()} · ${JSON.stringify(entry.details)}`
        ));
      });
    }

    const freightForm = document.getElementById('adminFreightForm');
    if (freightForm) freightForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      const button = freightForm.querySelector('button[type="submit"]');
      button.disabled = true;
      const data = new FormData(freightForm);
      try {
        await api('/api/admin/freight-rates', {
          method: 'POST',
          body: JSON.stringify({
            originProvince: data.get('originProvince'),
            destinationProvince: data.get('destinationProvince'),
            provider: data.get('provider'),
            amountKina: Number(data.get('amountKina')),
            isEstimate: data.get('isEstimate') === 'true',
            active: data.get('active') === 'true'
          })
        });
        freightForm.reset();
        showMessage(message, 'Freight rate saved.', 'success');
        await refresh();
      } catch (error) { showMessage(message, error.message, 'error'); }
      finally { button.disabled = false; }
    });

    try { await refresh(); }
    catch (error) { showMessage(message, error.message, 'error'); }
  }

  async function initVendorWorkspace() {
    const workspace = document.getElementById('vendorWorkspace');
    if (!workspace) return;
    const message = document.getElementById('vendorMessage');
    if (!currentUser) {
      window.location.assign('login.html?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search));
      return;
    }
    if (currentUser.role !== 'vendor') {
      showMessage(message, 'This area is for vendor accounts. Apply for a vendor account from the registration page.', 'error');
      return;
    }
    const application = document.getElementById('vendorApplication');
    const management = document.getElementById('vendorManagement');
    const businessInput = document.getElementById('vendorBusinessName');
    const provinceInput = document.getElementById('vendorProvince');
    const applicationForm = document.getElementById('vendorApplicationForm');
    const applicationPaymentMethods = document.getElementById('applicationPaymentMethods');
    const paymentForm = document.getElementById('vendorPaymentForm');
    const dashboardPaymentMethods = document.getElementById('dashboardPaymentMethods');
    const paymentStatus = document.getElementById('vendorPaymentStatus');
    const productForm = document.getElementById('vendorProductForm');
    const productFormStatus = document.getElementById('productFormStatus');
    const productFormTitle = document.getElementById('productFormTitle');
    const productFormBreadcrumb = document.getElementById('productFormBreadcrumb');
    const productsNode = document.getElementById('vendorProducts');
    const ordersNode = document.getElementById('vendorOrders');
    const provinceOptions = document.getElementById('deliveryProvinceOptions');
    const provinceContacts = document.getElementById('deliveryProvinceContacts');
    const deliveryContactsInput = productForm && productForm.elements.namedItem('deliveryContacts');
    const productProvinceInput = productForm && productForm.elements.namedItem('province');
    const productDeliveryTypeInput = productForm && productForm.elements.namedItem('deliveryType');
    const deliveryContactFields = [
      ['name', 'Driver or skipper name', 'text'],
      ['phone', 'Phone or WhatsApp number', 'tel'],
      ['transport', 'Vehicle, boat, or transport provider', 'text'],
      ['route', 'Route and pickup/drop-off point', 'text']
    ];
    const productId = productForm ? new URLSearchParams(window.location.search).get('id') : null;
    let productFormTargetValid = !productId;

    function renderDeliveryProvinceContacts(existingContacts) {
      if (!provinceOptions || !provinceContacts) return;
      const current = new Map((existingContacts || []).map(function (contact) {
        return [contact.province, contact];
      }));
      provinceOptions.replaceChildren();
      const province = productProvinceInput && productProvinceInput.value;
      if (province && pngProvinces.includes(province)) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = province;
        checkbox.checked = current.has(province) || (!productId &&
          (!productDeliveryTypeInput || productDeliveryTypeInput.value !== 'pickup'));
        checkbox.addEventListener('change', function () { renderContactFields(); });
        label.append(checkbox, document.createTextNode('Offer local delivery within ' + provinceLabel(province)));
        provinceOptions.appendChild(label);
      }
      renderContactFields(current.values());
    }

    function renderContactFields(defaultContacts) {
      if (!provinceOptions || !provinceContacts) return;
      const existing = new Map(Array.from(defaultContacts || []).map(function (contact) {
        return [contact.province, contact];
      }));
      Array.from(provinceContacts.querySelectorAll('.province-contact')).forEach(function (section) {
        const contact = { province: section.dataset.province };
        deliveryContactFields.forEach(function (definition) {
          const input = section.querySelector('[name="' + definition[0] + '"]');
          contact[definition[0]] = input ? input.value : '';
        });
        existing.set(contact.province, contact);
      });
      provinceContacts.replaceChildren();
      provinceOptions.querySelectorAll('input[type="checkbox"]:checked').forEach(function (checkbox) {
        const section = document.createElement('section');
        section.className = 'province-contact';
        section.dataset.province = checkbox.value;
        const heading = document.createElement('h3');
        heading.textContent = 'Delivery contact — ' + provinceLabel(checkbox.value);
        section.appendChild(heading);
        deliveryContactFields.forEach(function (definition) {
          const label = document.createElement('label');
          label.textContent = definition[1];
          const input = document.createElement('input');
          input.name = definition[0];
          input.type = definition[2];
          input.maxLength = 120;
          input.required = !productDeliveryTypeInput || productDeliveryTypeInput.value !== 'pickup';
          input.value = existing.has(checkbox.value) ? existing.get(checkbox.value)[definition[0]] || '' : '';
          if (definition[0] === 'phone') {
            input.placeholder = '+67570000000';
            input.pattern = '\\+675[78][0-9]{7}';
            input.title = 'Enter a valid PNG mobile number starting with +6757 or +6758.';
          }
          label.appendChild(input);
          section.appendChild(label);
        });
        provinceContacts.appendChild(section);
      });
    }

    function serializeDeliveryContacts() {
      if (!deliveryContactsInput || !provinceContacts) return;
      if (productDeliveryTypeInput && productDeliveryTypeInput.value === 'pickup') {
        deliveryContactsInput.value = '[]';
        return;
      }
      const contacts = Array.from(provinceContacts.querySelectorAll('.province-contact')).map(function (section) {
        const contact = { province: section.dataset.province };
        deliveryContactFields.forEach(function (definition) {
          contact[definition[0]] = section.querySelector('[name="' + definition[0] + '"]').value.trim();
        });
        return contact;
      }).filter(function (contact) {
        return Object.keys(contact).some(function (key) { return key !== 'province' && contact[key]; });
      });
      deliveryContactsInput.value = JSON.stringify(contacts);
    }

    renderDeliveryProvinceContacts();
    if (productProvinceInput) productProvinceInput.addEventListener('change', function () {
      renderDeliveryProvinceContacts();
    });
    if (productDeliveryTypeInput) productDeliveryTypeInput.addEventListener('change', function () {
      if (!provinceContacts) return;
      provinceContacts.querySelectorAll('input').forEach(function (input) {
        input.required = productDeliveryTypeInput.value !== 'pickup';
      });
    });

    if (productForm && productId) {
      if (!/^[1-9]\d*$/.test(productId)) {
        productFormTargetValid = false;
        showMessage(productFormStatus, 'The product ID is invalid.', 'error');
      } else {
        if (productFormTitle) productFormTitle.textContent = 'Edit product';
        if (productFormBreadcrumb) productFormBreadcrumb.textContent = 'Edit product';
        document.title = 'Edit product | KEDOLAKA MARKET';
        const submitButton = productForm.querySelector('button[type="submit"]');
        if (submitButton) submitButton.textContent = 'Save changes';
      }
    }

    async function refresh() {
      const result = await api('/api/vendor/dashboard');
      if (businessInput) businessInput.value = result.vendor.business_name || '';
      if (provinceInput) provinceInput.value = result.vendor.province;
      renderVendorPaymentSetup(applicationPaymentMethods, result.vendor.payment_methods);
      renderVendorPaymentSetup(dashboardPaymentMethods, result.vendor.payment_methods);
      if (result.vendor.status === 'active') {
        if (application) application.hidden = true;
        if (management) management.hidden = false;
        showMessage(message, 'Vendor account active.', 'success');
      } else {
        if (application) application.hidden = false;
        if (management) management.hidden = true;
        showMessage(message, 'Vendor application status: ' + result.vendor.status + '. Listings unlock after approval.');
      }
      if (productsNode) productsNode.replaceChildren();
      if (productsNode && !result.products.length) productsNode.textContent = 'No products listed.';
      result.products.forEach(function (product) {
        if (!productsNode) return;
        const row = document.createElement('li');
        const summary = document.createElement('span');
        const itemCondition = ({ new: 'New', used: 'Used', refurbished: 'Refurbished' })[product.item_condition] || product.item_condition;
        summary.textContent = `${product.product_name} · ${money(product.price_kina)} / ${product.price_unit} · ${itemCondition} · ${product.stock_quantity} in stock · ${deliveryTypeLabel(product.delivery_type)} · ${product.status}`;
        row.appendChild(summary);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.textContent = product.status === 'listed' ? 'Pause listing' : 'Publish listing';
        toggle.disabled = product.status === 'out_of_stock';
        toggle.addEventListener('click', async function () {
          try {
            await api('/api/vendor/products/' + product.product_id, {
              method: 'PATCH', body: JSON.stringify({ status: product.status === 'listed' ? 'paused' : 'listed' })
            });
            await refresh();
          } catch (error) { showMessage(message, error.message, 'error'); }
        });
        row.appendChild(toggle);
        const edit = document.createElement('a');
        edit.href = 'vendor-product-form.html?id=' + encodeURIComponent(product.product_id);
        edit.textContent = 'Edit details';
        row.appendChild(edit);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.addEventListener('click', async function () {
          if (!window.confirm('Delete this product listing?')) return;
          try {
            await api('/api/vendor/products/' + product.product_id, { method: 'DELETE' });
            await refresh();
          } catch (error) { showMessage(message, error.message, 'error'); }
        });
        row.appendChild(remove);
        productsNode.appendChild(row);
      });
      if (productForm) {
        const submitButton = productForm.querySelector('button[type="submit"]');
        if (productId) {
          const product = result.products.find(function (item) { return String(item.product_id) === productId; });
          productFormTargetValid = Boolean(product);
          if (!product) {
            showMessage(productFormStatus, 'That product was not found in your vendor listings.', 'error');
            if (submitButton) submitButton.disabled = true;
          } else {
            productForm.elements.namedItem('name').value = product.product_name;
            productForm.elements.namedItem('category').value = product.category;
            productForm.elements.namedItem('description').value = product.description || '';
            productForm.elements.namedItem('province').value = product.province;
            productForm.elements.namedItem('deliveryType').value = product.delivery_type || 'both';
            productForm.elements.namedItem('condition').value = product.item_condition || 'new';
            productForm.elements.namedItem('priceUnit').value = product.price_unit || 'item';
            productForm.elements.namedItem('deliveryNotes').value = product.delivery_notes || '';
            const additionalDetails = product.additional_details || {};
            ['brand', 'model', 'dimensions', 'materials', 'origin', 'warranty', 'deliveryAreas',
              'dispatchTime', 'deliveryEstimate', 'pickupDetails', 'deliveryRestrictions'].forEach(function (field) {
              const input = productForm.elements.namedItem(field);
              if (input) input.value = additionalDetails[field] || '';
            });
            renderDeliveryProvinceContacts((product.delivery_contacts || []).filter(function (contact) {
              return contact.province === product.province;
            }));
            productForm.elements.namedItem('priceKina').value = product.price_kina;
            productForm.elements.namedItem('stockQuantity').value = product.stock_quantity;
            productForm.elements.namedItem('imageUrl').value = product.image_url || '';
            if (submitButton) submitButton.disabled = false;
          }
        } else {
          productForm.elements.namedItem('province').value = result.vendor.province;
          renderDeliveryProvinceContacts();
        }
      }
      if (ordersNode) ordersNode.replaceChildren();
      if (ordersNode && !result.orders.length) ordersNode.textContent = 'No incoming orders.';
      result.orders.forEach(function (order) {
        if (!ordersNode) return;
        const row = document.createElement('li');
        const summary = document.createElement('span');
        summary.textContent = `Order #${order.order_id} · ${order.order_status} · Payment ${order.payment_status} (${order.payment_method}) · ${money(order.vendor_subtotal_kina)}`;
        row.appendChild(summary);
        const buyerDetails = document.createElement('small');
        buyerDetails.textContent = `Buyer: ${order.buyer_name} · ${order.delivery_address}, ${provinceLabel(order.delivery_province)} · ${order.phone_number} · ${order.shipping_provider} · ${order.shipping_payer === 'vendor' ? 'Vendor pays delivery' : 'Buyer pays delivery'}`;
        row.appendChild(buyerDetails);
        (order.delivery_contacts || []).forEach(function (entry) {
          const contactRow = document.createElement('small');
          contactRow.textContent = entry.productName + ' · ';
          appendDeliveryContact(contactRow, entry.contact);
          row.appendChild(contactRow);
        });
        if (['packed', 'shipped'].includes(order.order_status) &&
            (order.payment_status === 'successful' || order.payment_method === 'cash_on_delivery')) {
          const shipmentForm = document.createElement('form');
          shipmentForm.className = 'vendor-shipment-form';
          const fields = [
            ['carrier', 'Carrier', order.shipment_carrier || order.shipping_provider, 80],
            ['bookingReference', 'Booking reference', order.shipment_booking_reference || '', 120],
            ['trackingReference', 'Tracking number', order.shipment_tracking_reference || '', 120],
            ['trackingUrl', 'Tracking link (HTTPS)', order.shipment_tracking_url || '', 2000],
            ['notes', 'Shipment notes', order.shipment_notes || '', 500]
          ];
          if (order.shipping_provider === 'PMV') {
            fields.push(
              ['driverName', 'Driver name', order.shipment_driver_name || '', 120, 'text'],
              ['driverPhone', 'Driver PNG phone number', order.shipment_driver_phone || '', 30, 'tel'],
              ['vehiclePlate', 'Vehicle plate number', order.shipment_vehicle_plate || '', 20, 'text'],
              ['vehicleDescription', 'Vehicle type / description', order.shipment_vehicle_description || '', 120, 'text']
            );
          }
          fields.forEach(function (definition) {
            const label = document.createElement('label');
            label.textContent = definition[1];
            const input = document.createElement(definition[0] === 'notes' ? 'textarea' : 'input');
            input.name = definition[0];
            input.maxLength = definition[3];
            input.value = definition[2];
            if (definition[4]) input.type = definition[4];
            if (order.shipping_provider === 'PMV' &&
                ['driverName', 'driverPhone', 'vehiclePlate', 'vehicleDescription'].includes(definition[0])) {
              input.required = true;
            }
            if (definition[0] === 'driverPhone') {
              input.placeholder = '+67570000000';
              input.pattern = '\\+675[78][0-9]{7}';
            }
            label.appendChild(input);
            shipmentForm.appendChild(label);
          });
          const saveShipment = document.createElement('button');
          saveShipment.type = 'submit';
          saveShipment.textContent = 'Save shipment details';
          shipmentForm.appendChild(saveShipment);
          shipmentForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            saveShipment.disabled = true;
            try {
              await api('/api/vendor/orders/' + encodeURIComponent(order.order_id) + '/shipment', {
                method: 'PATCH',
                body: JSON.stringify(Object.fromEntries(new FormData(shipmentForm).entries()))
              });
              showMessage(message, 'Shipment details saved. Carrier booking is manual.', 'success');
              await refresh();
            } catch (error) {
              showMessage(message, error.message, 'error');
              saveShipment.disabled = false;
            }
          });
          row.appendChild(shipmentForm);
        }
        const paymentCanBeConfirmed = order.payment_method === 'cash_on_delivery'
          ? order.order_status === 'delivered'
          : ['manual_bank_transfer', 'mobile_wallet', 'in_person'].includes(order.payment_method) &&
            order.order_status === 'pending';
        if (order.payment_status === 'pending' && paymentCanBeConfirmed) {
          const noteLabel = document.createElement('label');
          noteLabel.textContent = 'Receipt/reference (optional) ';
          const noteInput = document.createElement('input');
          noteInput.type = 'text';
          noteInput.maxLength = 120;
          noteInput.autocomplete = 'off';
          noteInput.setAttribute('aria-label', 'Receipt reference for order ' + order.order_id);
          noteLabel.appendChild(noteInput);
          row.appendChild(noteLabel);
          const confirmPayment = document.createElement('button');
          confirmPayment.type = 'button';
          confirmPayment.textContent = 'Confirm payment received';
          confirmPayment.addEventListener('click', async function () {
            if (!window.confirm('Confirm only if your business has actually received payment for this order. This records your attestation; it is not independently verified by a payment provider.')) return;
            confirmPayment.disabled = true;
            try {
              const confirmation = await api('/api/vendor/orders/' + encodeURIComponent(order.order_id) + '/payment-confirmation', {
                method: 'POST',
                body: JSON.stringify({ verificationReference: noteInput.value.trim() })
              });
              showMessage(message, confirmation.message, 'success');
              await refresh();
            } catch (error) {
              showMessage(message, error.message, 'error');
              confirmPayment.disabled = false;
            }
          });
          row.appendChild(confirmPayment);
        } else if (order.payment_status === 'successful' && order.vendor_confirmed_receipt) {
          const confirmation = document.createElement('small');
          confirmation.textContent = 'Receipt confirmation recorded by this vendor (not provider-verified).';
          row.appendChild(confirmation);
        }
        const nextStatus = { pending: 'confirmed', confirmed: 'packed', packed: 'shipped', shipped: 'delivered' }[order.order_status];
        if (nextStatus) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Mark ' + nextStatus;
          button.addEventListener('click', async function () {
            try {
              await api('/api/vendor/orders/' + order.order_id + '/status', { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) });
              await refresh();
            } catch (error) { showMessage(message, error.message, 'error'); }
          });
          row.appendChild(button);
        }
        ordersNode.appendChild(row);
      });
    }

    if (applicationForm) applicationForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      const submitButton = applicationForm.querySelector('button[type="submit"]');
      const paymentMethods = readVendorPaymentSetup(applicationPaymentMethods);
      const paymentError = getVendorPaymentSetupError(applicationPaymentMethods);
      if (paymentError) {
        showMessage(message, paymentError, 'error');
        return;
      }
      submitButton.disabled = true;
      try {
        await api('/api/vendor/profile', { method: 'POST', body: JSON.stringify({
          businessName: businessInput.value, province: provinceInput.value, paymentMethods
        }) });
        await refresh();
      } catch (error) { showMessage(message, error.message, 'error'); }
      finally { submitButton.disabled = false; }
    });
    if (paymentForm) paymentForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      const submitButton = paymentForm.querySelector('button[type="submit"]');
      const methods = readVendorPaymentSetup(dashboardPaymentMethods);
      const paymentError = getVendorPaymentSetupError(dashboardPaymentMethods);
      if (paymentError) {
        showMessage(paymentStatus, paymentError, 'error');
        return;
      }
      submitButton.disabled = true;
      showMessage(paymentStatus, 'Saving payment methods...');
      try {
        const result = await api('/api/vendor/payment-methods', {
          method: 'PATCH',
          body: JSON.stringify({ paymentMethods: methods })
        });
        renderVendorPaymentSetup(dashboardPaymentMethods, result.vendor.payment_methods);
        renderVendorPaymentSetup(applicationPaymentMethods, result.vendor.payment_methods);
        showMessage(paymentStatus, result.message, 'success');
      } catch (error) {
        showMessage(paymentStatus, error.message, 'error');
      } finally {
        submitButton.disabled = false;
      }
    });
    if (productForm) productForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!productFormTargetValid) return;
      serializeDeliveryContacts();
      if (!productForm.reportValidity()) return;
      const formData = new FormData(productForm);
      const submitButton = productForm.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      try {
        if (productId) {
          await api('/api/vendor/products/' + encodeURIComponent(productId), { method: 'PATCH', body: formData });
          showMessage(productFormStatus, 'Product listing updated.', 'success');
        } else {
          await api('/api/vendor/products', { method: 'POST', body: formData });
          productForm.reset();
          showMessage(productFormStatus, 'Product listing created.', 'success');
        }
        await refresh();
      } catch (error) { showMessage(productFormStatus || message, error.message, 'error'); }
      finally { submitButton.disabled = !productFormTargetValid; }
    });
    try { await refresh(); }
    catch (error) { showMessage(message, error.message, 'error'); }
  }

  document.addEventListener('DOMContentLoaded', async function () {
    setupPwa();
    setupBreadcrumbs();
    const cartCheckoutLink = document.getElementById('cartCheckoutLink');
    if (cartCheckoutLink) {
      cartCheckoutLink.addEventListener('click', function (event) {
        if (cartCheckoutLink.getAttribute('aria-disabled') === 'true') event.preventDefault();
      });
    }
    bindAuthForms();
    const sessionPromise = loadSession();
    const search = document.getElementById('keywordSearch');
    const category = document.getElementById('categoryFilter');
    const homeSearchSubmit = document.getElementById('homeSearchSubmit');
    function updateHomeSearchLink() {
      if (!homeSearchSubmit) return;
      const params = new URLSearchParams();
      if (search && search.value.trim()) params.set('q', search.value.trim());
      if (category && category.value && category.value !== 'all') params.set('category', category.value);
      homeSearchSubmit.href = '/products' + (params.size ? '?' + params.toString() : '');
    }
    const province = document.getElementById('provinceFilter');
    const sort = document.getElementById('sortFilter');
    const minimumPrice = document.getElementById('minimumPriceFilter');
    const maximumPrice = document.getElementById('maximumPriceFilter');
    function resetCatalog() {
      catalogOffset = 0;
      loadProducts();
    }
    const searchForm = document.getElementById('searchFilters');
    if (searchForm) searchForm.addEventListener('submit', function (event) {
      event.preventDefault();
      resetCatalog();
    });
    if (search) search.addEventListener('input', function () {
      window.clearTimeout(catalogTimer);
      catalogTimer = window.setTimeout(resetCatalog, 250);
      updateHomeSearchLink();
    });
    if (category) category.addEventListener('change', function () {
      resetCatalog();
      updateHomeSearchLink();
    });
    updateHomeSearchLink();
    if (province) province.addEventListener('change', function () {
      if (province.value && province.value !== 'all') saveDeliveryProvince(province.value);
      resetCatalog();
    });
    if (sort) sort.addEventListener('change', resetCatalog);
    if (minimumPrice) minimumPrice.addEventListener('input', function () {
      window.clearTimeout(catalogTimer);
      catalogTimer = window.setTimeout(resetCatalog, 250);
    });
    if (maximumPrice) maximumPrice.addEventListener('input', function () {
      window.clearTimeout(catalogTimer);
      catalogTimer = window.setTimeout(resetCatalog, 250);
    });
    const provinceButton = document.getElementById('provinceSetButton');
    if (provinceButton) provinceButton.addEventListener('click', applyDeliveryProvince);
    const sessionProvinceSelect = document.getElementById('sessionProvinceSelect');
    if (sessionProvinceSelect) sessionProvinceSelect.addEventListener('change', applyDeliveryProvince);
    const deliveryProvince = document.getElementById('deliveryProvince');
    if (deliveryProvince) deliveryProvince.addEventListener('change', function () {
      if (deliveryProvince.value) saveDeliveryProvince(deliveryProvince.value);
      updateShippingProviderAvailability();
      updateCheckoutAvailability();
      refreshCheckoutLocalContacts();
      refreshFreightEstimate();
    });
    document.querySelectorAll('input[name="carrierMethod"]').forEach(function (input) {
      input.addEventListener('change', refreshFreightEstimate);
    });
    await sessionPromise;
    setupSharedNavigation();
    guardPageAccess();
    bindCheckout();
    Promise.all([
      document.getElementById('cartItems') ? loadCart() : refreshCartCount(),
      loadCategories(),
      loadProducts(),
      loadOrderHistory(),
      loadProductDetail(),
      loadOrderDetail(),
      loadPaymentStatus(),
      initMessenger(),
      initAccountProfile(),
      initVendorWorkspace(),
      initAdminWorkspace()
    ]).catch(function (error) {
      console.error('Could not initialize marketplace page:', error);
    }).finally(function () {
      window.dispatchEvent(new Event('marketplace:ready'));
    });
  });
})();