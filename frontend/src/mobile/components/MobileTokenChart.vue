<template>
  <div class="mobile-token-chart">
    <div class="chart-title">{{ title }}</div>
    <div class="chart-container">
      <van-loading v-if="loading" type="spinner" class="chart-loading" />
      <div v-else-if="!data || data.length === 0" class="chart-empty">暂无数据</div>
      <canvas v-show="!loading && data && data.length > 0" ref="canvasRef" class="chart-canvas" />
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, onMounted, watch, onUnmounted } from 'vue';
import type { TokenStat } from '@/api/tokenStatsService';
interface Props { data?: TokenStat[]; loading?: boolean; title?: string; }
const props = withDefaults(defineProps<Props>(), { data: () => [], loading: false, title: '使用统计' });
const canvasRef = ref<HTMLCanvasElement>();
let animationFrame: number | null = null;
const drawChart = () => {
  if (!canvasRef.value || !props.data || props.data.length === 0) return;
  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.parentElement?.clientWidth || 300;
  const h = 180;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
  const pad = { top: 15, right: 15, bottom: 30, left: 45 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  ctx.clearRect(0, 0, w, h);
  const labels = props.data.map(d => d.stat_date.slice(5));
  const values = props.data.map(d => d.total_token);
  const max = Math.max(...values, 1);
  ctx.strokeStyle = '#ebedf0';
  ctx.setLineDash([3, 3]);
  for (let i = 0; i <= 3; i++) { const y = pad.top + (ch / 3) * i; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke(); ctx.fillStyle = '#969799'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right'; ctx.fillText((max * (3 - i) / 3).toFixed(0), pad.left - 5, y + 3); }
  ctx.setLineDash([]);
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, 'rgba(64, 158, 255, 0.3)');
  grad.addColorStop(1, 'rgba(64, 158, 255, 0)');
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + ch);
  values.forEach((v, i) => { const x = pad.left + (cw / (values.length - 1 || 1)) * i; const y = pad.top + ch - (v / max) * ch; ctx.lineTo(x, y); });
  ctx.lineTo(pad.left + cw, pad.top + ch);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  values.forEach((v, i) => { const x = pad.left + (cw / (values.length - 1 || 1)) * i; const y = pad.top + ch - (v / max) * ch; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.strokeStyle = '#409eff';
  ctx.lineWidth = 2;
  ctx.stroke();
  values.forEach((v, i) => { const x = pad.left + (cw / (values.length - 1 || 1)) * i; const y = pad.top + ch - (v / max) * ch; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); });
  ctx.fillStyle = '#969799';
  ctx.textAlign = 'center';
  labels.forEach((l, i) => { if (i % Math.ceil(labels.length / 5) === 0 || i === labels.length - 1) { const x = pad.left + (cw / (labels.length - 1 || 1)) * i; ctx.fillText(l, x, pad.top + ch + 18); } });
};
watch(() => props.data, () => drawChart(), { deep: true });
watch(() => props.loading, (v) => { if (!v) setTimeout(drawChart, 100); });
onMounted(() => { drawChart(); window.addEventListener('resize', () => { if (animationFrame) cancelAnimationFrame(animationFrame); animationFrame = requestAnimationFrame(drawChart); }); });
onUnmounted(() => { window.removeEventListener('resize', () => {}); if (animationFrame) cancelAnimationFrame(animationFrame); });
</script>
<style scoped lang="less">.mobile-token-chart { background: #fff; border-radius: 8px; margin: 12px; padding: 12px; } .chart-title { font-size: 14px; font-weight: 600; color: #323233; margin-bottom: 10px; } .chart-container { position: relative; height: 180px; } .chart-loading, .chart-empty { display: flex; justify-content: center; align-items: center; height: 100%; color: #969799; } .chart-canvas { display: block; width: 100%; height: 180px; }
</style>
