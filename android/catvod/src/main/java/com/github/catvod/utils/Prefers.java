package com.github.catvod.utils;

import android.content.SharedPreferences;

import androidx.preference.PreferenceManager;

import com.github.catvod.Runtime;

public class Prefers {

    public static SharedPreferences getPrefers() {
        return PreferenceManager.getDefaultSharedPreferences(Runtime.context());
    }

    public static String getString(String key) {
        return getString(key, "");
    }

    public static String getString(String key, String defaultValue) {
        try {
            return getPrefers().getString(key, defaultValue);
        } catch (Exception e) {
            return defaultValue;
        }
    }

    public static int getInt(String key) {
        return getInt(key, 0);
    }

    public static int getInt(String key, int defaultValue) {
        try {
            return getPrefers().getInt(key, defaultValue);
        } catch (Exception e) {
            return defaultValue;
        }
    }

    public static long getLong(String key) {
        return getLong(key, 0L);
    }

    public static long getLong(String key, long defaultValue) {
        try {
            return getPrefers().getLong(key, defaultValue);
        } catch (Exception e) {
            return defaultValue;
        }
    }

    public static float getFloat(String key) {
        return getFloat(key, 0f);
    }

    public static float getFloat(String key, float defaultValue) {
        try {
            return getPrefers().getFloat(key, defaultValue);
        } catch (Exception e) {
            return defaultValue;
        }
    }

    public static boolean getBoolean(String key) {
        return getBoolean(key, false);
    }

    public static boolean getBoolean(String key, boolean defaultValue) {
        try {
            return getPrefers().getBoolean(key, defaultValue);
        } catch (Exception e) {
            return defaultValue;
        }
    }

    public static void put(String key, Object obj) {
        // YunYing 补丁：Java 17 禁用了 switch 模式匹配（preview），改写为 instanceof 链
        if (obj instanceof String) getPrefers().edit().putString(key, (String) obj).apply();
        else if (obj instanceof Boolean) getPrefers().edit().putBoolean(key, (Boolean) obj).apply();
        else if (obj instanceof Float) getPrefers().edit().putFloat(key, (Float) obj).apply();
        else if (obj instanceof Integer) getPrefers().edit().putInt(key, (Integer) obj).apply();
        else if (obj instanceof Long) getPrefers().edit().putLong(key, (Long) obj).apply();
        else if (obj instanceof Number) {
            Number val = (Number) obj;
            if (val.toString().contains(".")) put(key, val.floatValue());
            else put(key, val.intValue());
        }
    }

    public static void remove(String key) {
        getPrefers().edit().remove(key).apply();
    }
}
