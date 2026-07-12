const form = document.getElementById('login-form');
const username = document.getElementById('login-username');
const password = document.getElementById('login-password');

// signup.html loads this file too, and it has no #login-form (its form is
// #signup-form), so `form` is null there — calling .addEventListener on it threw
// "Cannot read properties of null" and killed the rest of that page's scripts.
if (form) {
  form.addEventListener('submit', (e) => {
     // e.preventDefault();
  })
}