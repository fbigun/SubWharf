import { describe, expect, it } from 'vitest';
import { cleanNodeName } from '../src/rename';

describe('cleanNodeName', () => {
  it('中文国名 + 家宽/IPLC/倍率全部保留', () => {
    expect(cleanNodeName('🇭🇰 香港 01 | 家宽 IPLC ˣ²')).toBe('香港 2× 家宽 IPLC');
  });

  it('国旗优先于其它写法', () => {
    expect(cleanNodeName('🇭🇰 HK-01')).toBe('香港');
    expect(cleanNodeName('🇹🇷 伊斯坦布尔')).toBe('土耳其');
  });

  it('英文缩写 + 小数倍率', () => {
    expect(cleanNodeName('US-01 | 0.1x')).toBe('美国 0.1×');
    expect(cleanNodeName('Singapore x0.2')).toBe('新加坡 0.2×');
  });

  it('城市别名 + 倍/特殊标识', () => {
    expect(cleanNodeName('东京 IEPL 3倍')).toBe('日本 3× IEPL');
    expect(cleanNodeName('深港 6x')).toBe('香港 6×');
  });

  it('数值 1 的倍率不保留', () => {
    expect(cleanNodeName('HK-01 1x')).toBe('香港');
  });

  it('上标倍率按最长匹配，重复倍率去重', () => {
    expect(cleanNodeName('香港 ˣ²⁰')).toBe('香港 20×');
    expect(cleanNodeName('香港 家宽 2x ˣ²')).toBe('香港 2× 家宽');
  });

  it('英文全称与 UK 别名', () => {
    expect(cleanNodeName('United States')).toBe('美国');
    expect(cleanNodeName('英国 UK-01')).toBe('英国');
    expect(cleanNodeName('Hong Kong 01')).toBe('香港');
  });

  it('地区判断顺序：城市别名/中文优先于国旗', () => {
    expect(cleanNodeName('🇺🇸 香港 01')).toBe('香港');
    expect(cleanNodeName('🇸🇬 东京 01')).toBe('日本');
  });

  it('英文缩写按非字母边界匹配，避免单词误判', () => {
    expect(cleanNodeName('HK01')).toBe('香港');
    expect(cleanNodeName('NODE-01')).toBe('NODE-01');
    expect(cleanNodeName('TROJAN-01')).toBe('TROJAN-01');
    expect(cleanNodeName('comparison')).toBe('comparison');
  });

  it('未识别地区原样返回', () => {
    expect(cleanNodeName('My Node')).toBe('My Node');
    expect(cleanNodeName('')).toBe('');
  });
});
