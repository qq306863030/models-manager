import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import App from './App.vue';
import router from './router';

const app = createApp(App);

// 娉ㄥ唽鎵€鏈夊浘鏍?
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(ElementPlus);
app.use(router);

// 鍏ㄥ眬鏍峰紡锛岃皟缁撴灉body padding
const style = document.createElement('style');
style.textContent = 'body { margin: 0; padding: 0; }';
document.head.appendChild(style);

app.mount('#app');