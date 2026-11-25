/**
 * ZeroVault App 内同源几何盾锁 BrandLogo（与 Android 桌面 Adaptive Icon 完全同源）。
 * 零外部图片依赖，任意尺寸清晰锐利。
 */
import React from 'react';
import { Text, View } from 'react-native';

export function BrandLogo({ size = 56 }: { readonly size?: number }): React.JSX.Element {
  const outerRadius = Math.round(size * 0.26);
  const innerSize = Math.round(size * 0.64);
  const innerRadius = Math.round(innerSize * 0.24);
  const dotSize = Math.max(4, Math.round(size * 0.1));

  return (
    <View
      accessibilityLabel="ZeroVault 徽标"
      style={{
        width: size,
        height: size,
        borderRadius: outerRadius,
        backgroundColor: '#14495E',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: Math.max(1.5, size * 0.03),
        borderColor: '#2B89A8',
      }}
    >
      {/* 内盾牌壳体 */}
      <View
        style={{
          width: innerSize,
          height: Math.round(innerSize * 1.06),
          borderTopLeftRadius: innerRadius,
          borderTopRightRadius: innerRadius,
          borderBottomLeftRadius: Math.round(innerSize * 0.48),
          borderBottomRightRadius: Math.round(innerSize * 0.48),
          backgroundColor: '#0E2E3E',
          borderWidth: Math.max(2, Math.round(size * 0.055)),
          borderColor: '#F4FAFC',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            color: '#5CC3DF',
            fontSize: Math.round(size * 0.34),
            fontWeight: '700',
            lineHeight: Math.round(size * 0.38),
            includeFontPadding: false,
          }}
        >
          Z
        </Text>
        <View
          style={{
            position: 'absolute',
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: '#F4FAFC',
          }}
        />
      </View>
    </View>
  );
}
