// Appends the newsletter form to the footer at load. The form exists only in the DOM, never in the source.
const MARKUP = `<form class="newsletter"><input id="email" type="email"><button type="submit">Subscribe</button></form>`;
document.querySelector("footer").insertAdjacentHTML("beforeend", MARKUP);
