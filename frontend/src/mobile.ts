/**
 * 移动端主入口
 */
import { createApp } from 'vue';
import router from './mobile/router';
import App from './mobile/App.vue';
import 'vant/lib/index.css';
import './mobile/styles/main.less';

import { Tab, Tabs, Cell, CellGroup, Field, Button, Form, Popup, Dialog, Toast, NavBar, Icon, ActionSheet, Empty, SwipeCell, Image as VanImage, Tag, Checkbox, CheckboxGroup, PullRefresh, List, Loading, Divider, Picker } from 'vant';

const app = createApp(App);
app.use(Tab).use(Tabs).use(Cell).use(CellGroup).use(Field).use(Button).use(Form).use(Popup).use(Dialog).use(Toast).use(NavBar).use(Icon).use(ActionSheet).use(Empty).use(SwipeCell).use(VanImage).use(Tag).use(Checkbox).use(CheckboxGroup).use(PullRefresh).use(List).use(Loading).use(Divider).use(Picker);
app.use(router);
app.mount('#app');
