// firebasePush.js
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import products from './products.json' assert { type: 'json' };

// Firebase config
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "XXXX",
  appId: "XXXX"
};

// Init Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Upload products from JSON
(async () => {
  for (const product of products) {
    try {
      await setDoc(doc(db, 'products', product.id), product);
      console.log(`✅ Uploaded: ${product.title}`);
    } catch (err) {
      console.error(`❌ Failed: ${product.title}`, err);
    }
  }
})();
