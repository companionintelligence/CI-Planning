// The connect page: the one page this app ships. It asks for the server's address and hands it
// to Rust, which checks that a Companion Planning server answers there, saves the address and
// sends this window to it. Nothing here calls the server, so the server's CORS policy does not
// come into it.
(() => {
  const { invoke } = window.__TAURI__.core;
  const form = document.getElementById('connect-form');
  const input = document.getElementById('server');
  const button = document.getElementById('connect');
  const message = document.getElementById('message');

  const say = (text, isError = false) => {
    message.textContent = text;
    message.classList.toggle('error', isError);
  };

  invoke('saved_server')
    .then((saved) => {
      if (saved) input.value = saved;
    })
    .catch(() => {});

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    say('Checking the address…');
    button.disabled = true;
    try {
      await invoke('connect_server', { input: input.value });
      // On success Rust has already sent this window to the server.
    } catch (error) {
      say(String(error), true);
      button.disabled = false;
    }
  });
})();
