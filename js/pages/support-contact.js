(function () {
  'use strict';

  const supportContact = {
    email: 'akonabengie@gmail.com',
    phone: '74374158',
    whatsapp: '74374158',
    hours: '7:00am - 10:00pm',
  };

  function appendContactLink(list, label, value, href) {
    if (!value) return;
    const item = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = label + ': ';
    const link = document.createElement('a');
    link.href = href;
    link.textContent = value;
    item.append(name, link);
    list.appendChild(item);
  }

  document.querySelectorAll('[data-support-contact]').forEach(function (container) {
    const list = container.querySelector('[data-support-contact-details]');
    const emptyMessage = container.querySelector('[data-support-contact-empty]');
    let contactCount = 0;

    if (supportContact.email.trim()) {
      appendContactLink(list, 'Email', supportContact.email.trim(), 'mailto:' + supportContact.email.trim());
      contactCount += 1;
    }
    if (supportContact.phone.trim()) {
      const phone = supportContact.phone.trim();
      const dialable = phone.replace(/[^\d+]/g, '');
      appendContactLink(list, 'Phone', phone, 'tel:' + dialable);
      contactCount += 1;
    }
    if (supportContact.whatsapp.trim()) {
      const whatsapp = supportContact.whatsapp.trim();
      const number = whatsapp.replace(/\D/g, '');
      if (number) {
        appendContactLink(list, 'WhatsApp', whatsapp, 'https://wa.me/' + number);
        contactCount += 1;
      }
    }
    if (supportContact.hours.trim()) {
      const item = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = 'Support hours: ';
      item.append(label, document.createTextNode(supportContact.hours.trim()));
      list.appendChild(item);
      contactCount += 1;
    }

    if (emptyMessage) emptyMessage.hidden = contactCount > 0;
    if (list) list.hidden = contactCount === 0;
  });
}());
