# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class com.frontierwire.** { *** Companion; }
-keepclasseswithmembers class com.frontierwire.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.frontierwire.**$$serializer { *; }
