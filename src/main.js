import { createApp } from 'vue'
import App from './App.vue'

// Import Tailwind CSS
import './assets/main.css'

// Import Quasar CSS and framework
import { Quasar } from 'quasar'
import quasarLang from 'quasar/lang/en-US'
import quasarIconSet from 'quasar/icon-set/material-icons'

// Quasar styles are automatically imported by the Vite plugin

// Import icon libraries
import '@quasar/extras/material-icons/material-icons.css'

const app = createApp(App)

app.use(Quasar, {
  plugins: {}, // import Quasar plugins and add here
  lang: quasarLang,
  iconSet: quasarIconSet,
})

app.mount('#app')
