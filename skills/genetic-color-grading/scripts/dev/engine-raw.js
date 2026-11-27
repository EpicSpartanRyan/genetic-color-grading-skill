
(function(){
"use strict";
/* ==================================================================
   Motor de filtros — el mismo del Color Enhance Studio original.
   Cada filtro opera sobre el array RGBA de una ImageData.
   ================================================================== */
var SRGB_TO_LINEAR=new Float32Array(256);
for(var li=0;li<256;li++){ var lc=li/255; SRGB_TO_LINEAR[li]= lc<=0.04045 ? lc/12.92 : Math.pow((lc+0.055)/1.055,2.4); }
/* Indice seguro a la tabla sRGB->lineal: la cadena es float32 y un paso
   anterior (WB, exposicion, curvas) puede dejar valores no enteros;
   indexar la tabla con un float da undefined -> NaN -> celdas negras
   (p. ej. AgX tras un balance de blancos distinto de 6500K). Redondear
   y limitar es exacto para entradas enteras, que es el caso que antes
   funcionaba. */
function srgbLin(v){ return SRGB_TO_LINEAR[v<0?0 : v>255?255 : (v+0.5)|0]; }
var ENC_N=4096, LINEAR_TO_SRGB=new Float32Array(ENC_N+1);
for(var ei=0;ei<=ENC_N;ei++){ var ec=ei/ENC_N; LINEAR_TO_SRGB[ei]=(ec<=0.0031308 ? 12.92*ec : 1.055*Math.pow(ec,1/2.4)-0.055)*255; }
function encode255(c){
  if(c<=0.0031308) return 12.92*c*255;
  return (1.055*Math.pow(c,1/2.4)-0.055)*255;
}
/* sRGB → lineal analítico para un canal flotante en escala 0..255: la
   misma fórmula con la que se construye SRGB_TO_LINEAR, pero sin pasar
   por la tabla de 256 entradas, así la cadena CPU puede trabajar con
   valores flotantes entre filtros sin recuantizar a enteros. */
function srgbLin255(v){ var c=v/255; return c<=0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
/* Modo diagnóstico de gamut: SOLO lo activa analyzePipelineDetailed
   mientras ejecuta un paso, para poder medir los canales que ese paso
   empuja fuera de [0, 255] ANTES del recorte. Con el clamp siempre
   activo ningún canal quedaría fuera al llegar al diagnóstico y el
   indicador «Fuera de gamut» no podría disparar nunca. El pipeline
   real, la vista previa y la exportación nunca activan este modo.
   El typeof protege a los workers: su código se genera desde el
   toString de estas funciones y allí la variable no existe. */
var DIAG_RAW_GAMUT=false;
function clamp255(v){ return (typeof DIAG_RAW_GAMUT!=="undefined" && DIAG_RAW_GAMUT) ? v : (v<0?0 : v>255?255 : v); }

function applyLinearSat(d, f){
  if(f===1) return;
  var inv=1-f;
  for(var i=0;i<d.length;i+=4){
    var l=0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    d[i]  = clamp255(l*inv + d[i]*f);
    d[i+1]= clamp255(l*inv + d[i+1]*f);
    d[i+2]= clamp255(l*inv + d[i+2]*f);
  }
}

var XN=95.047, YN=100.0, ZN=108.883;
var DELTA=6/29, D3=DELTA*DELTA*DELTA, TD2=3*DELTA*DELTA;
function labF(t){ return t>D3 ? Math.cbrt(t) : t/TD2 + 4/29; }
function labFInv(t){ return t>DELTA ? t*t*t : TD2*(t-4/29); }
function applyCielch(d, strength){
  if(strength===0) return;
  var n=d.length, count=n/4;
  var Ls=new Float32Array(count), as=new Float32Array(count), bs=new Float32Array(count);
  var maxC=0, p=0;
  for(var i=0;i<n;i+=4){
    var R=srgbLin(d[i]), G=srgbLin(d[i+1]), B=srgbLin(d[i+2]);
    var X=(0.4124564*R + 0.3575761*G + 0.1804375*B)*100;
    var Y=(0.2126729*R + 0.7151522*G + 0.0721750*B)*100;
    var Z=(0.0193339*R + 0.1191920*G + 0.9503041*B)*100;
    var fx=labF(X/XN), fy=labF(Y/YN), fz=labF(Z/ZN);
    var a=500*(fx-fy), b=200*(fy-fz);
    Ls[p]=116*fy-16; as[p]=a; bs[p]=b;
    var C=Math.sqrt(a*a+b*b);
    if(C>maxC) maxC=C;
    p++;
  }
  var target=(1-strength)*100 + strength*maxC;
  var factor= target>0 ? 100/target : 1;
  if(factor===1) return;
  p=0;
  for(var j=0;j<n;j+=4){
    var L=Ls[p], a2=as[p], b2=bs[p];
    var C2=Math.sqrt(a2*a2+b2*b2);
    if(C2>0){
      var h=Math.atan2(b2,a2);
      var Cn=C2*factor;
      a2=Cn*Math.cos(h); b2=Cn*Math.sin(h);
    }
    var fy2=(L+16)/116, fx2=fy2+a2/500, fz2=fy2-b2/200;
    var Xo=labFInv(fx2)*XN/100, Yo=labFInv(fy2)*YN/100, Zo=labFInv(fz2)*ZN/100;
    var Rl= 3.2404542*Xo - 1.5371385*Yo - 0.4985314*Zo;
    var Gl=-0.9692660*Xo + 1.8760108*Yo + 0.0415560*Zo;
    var Bl= 0.0556434*Xo - 0.2040259*Yo + 1.0572252*Zo;
    d[j]=clamp255(encode255(Rl)); d[j+1]=clamp255(encode255(Gl)); d[j+2]=clamp255(encode255(Bl));
    p++;
  }
}

function srgbToOklab(R,G,B, out){
  var r=srgbLin255(R), g=srgbLin255(G), b=srgbLin255(B);
  var l=0.4122214708*r + 0.5363325363*g + 0.0514459929*b;
  var m=0.2119034982*r + 0.6806995451*g + 0.1073969566*b;
  var s=0.0883024619*r + 0.2817188376*g + 0.6299787005*b;
  var l_=Math.cbrt(l), m_=Math.cbrt(m), s_=Math.cbrt(s);
  out[0]=0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_;
  out[1]=1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_;
  out[2]=0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_;
}
function oklabToSrgb(L,a,b, d, idx){
  var l_=L + 0.3963377774*a + 0.2158037573*b;
  var m_=L - 0.1055613458*a - 0.0638541728*b;
  var s_=L - 0.0894841775*a - 1.2914855480*b;
  var l=l_*l_*l_, m=m_*m_*m_, s=s_*s_*s_;
  var r= 4.0767416621*l - 3.3077115913*m + 0.2309699292*s;
  var g=-1.2684380046*l + 2.6097574011*m - 0.3413193965*s;
  var bb=-0.0041960863*l - 0.7034186147*m + 1.7076147010*s;
  d[idx]=clamp255(encode255(r)); d[idx+1]=clamp255(encode255(g)); d[idx+2]=clamp255(encode255(bb));
}
function applyOklch(d, factor){
  if(factor===1) return;
  var lab=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    srgbToOklab(d[i],d[i+1],d[i+2],lab);
    var L=lab[0], a=lab[1], b=lab[2];
    var C=Math.sqrt(a*a+b*b);
    if(C>1e-9){
      var h=Math.atan2(b,a);
      var Cn=C*factor;
      a=Cn*Math.cos(h); b=Cn*Math.sin(h);
    }
    oklabToSrgb(L,a,b,d,i);
  }
}

function isSkin(r,g,b){
  if(!(r>g && g>b)) return 0;
  var mx=r, mn=b;
  if(mx-mn < 18 || mx-mn > 110) return 0;
  if(r<90) return 0;
  var hue=Math.atan2(Math.sqrt(3)*(g-b), 2*r-g-b) * 180/Math.PI;
  if(hue<0) hue+=360;
  return (hue>=8 && hue<=52) ? 1 : 0;
}
function applyVibrance(d, v){
  if(v===0) return;
  for(var i=0;i<d.length;i+=4){
    var r=d[i], g=d[i+1], b=d[i+2];
    var mx=Math.max(r,g,b), mn=Math.min(r,g,b);
    var sat= mx>0 ? (mx-mn)/mx : 0;
    var weight=1-sat;
    if(isSkin(r,g,b)) weight*=0.3;
    var f=1 + v * weight * 1.35;
    if(f===1) continue;
    var lum=0.299*r + 0.587*g + 0.114*b;
    d[i]  = clamp255(lum + (r-lum)*f);
    d[i+1]= clamp255(lum + (g-lum)*f);
    d[i+2]= clamp255(lum + (b-lum)*f);
  }
}

function applyContrastTemp(d, con, temp){
  if(con===0 && temp===0) return;
  var lab=[0,0,0];
  var bShift=temp*0.07;
  for(var i=0;i<d.length;i+=4){
    srgbToOklab(d[i],d[i+1],d[i+2],lab);
    var L=lab[0], a=lab[1], b=lab[2];
    if(con!==0){
      var Lc=L<0?0 : L>1?1 : L;
      L = L + con * 3 * Lc*(1-Lc)*(Lc-0.5);
    }
    if(temp!==0) b = b + bShift;
    oklabToSrgb(L,a,b,d,i);
  }
}

function inv3(m){
  var a=m[0],b=m[1],c=m[2],d=m[3],e=m[4],f=m[5],g=m[6],h=m[7],i=m[8];
  var A=e*i-f*h, B=f*g-d*i, C=d*h-e*g, det=a*A+b*B+c*C;
  if(!det) det=1;
  return [ A/det,(c*h-b*i)/det,(b*f-c*e)/det,
           B/det,(a*i-c*g)/det,(c*d-a*f)/det,
           C/det,(b*g-a*h)/det,(a*e-b*d)/det ];
}
function xyzFromLinear(R,G,B,out){
  out[0]=0.4124564*R + 0.3575761*G + 0.1804375*B;
  out[1]=0.2126729*R + 0.7151522*G + 0.0721750*B;
  out[2]=0.0193339*R + 0.1191920*G + 0.9503041*B;
}
function linearFromXyz(X,Y,Z,d,idx){
  var r= 3.2404542*X - 1.5371385*Y - 0.4985314*Z;
  var g=-0.9692660*X + 1.8760108*Y + 0.0415560*Z;
  var b= 0.0556434*X - 0.2040259*Y + 1.0572252*Z;
  d[idx]=clamp255(encode255(r)); d[idx+1]=clamp255(encode255(g)); d[idx+2]=clamp255(encode255(b));
}

var CAT16=[0.401288,0.650173,-0.051461, -0.250268,1.204414,0.045854, -0.002079,0.048952,0.953127];
var INV_CAT16=inv3(CAT16);
var OPP_MAT=[2,1,0.05, 1,-12/11,1/11, 1/9,1/9,-2/9];
var INV_OPP=inv3(OPP_MAT);
var HCT_FL=0, HCT_RGBD=[1,1,1];
(function initHct(){
  var La=11.725891216882687;
  var k=1/(5*La+1);
  HCT_FL=0.2*Math.pow(k,4)*La + 0.1*Math.pow(1-Math.pow(k,4),2)*Math.cbrt(5*La);
  var D=1 - (1/3.6)*Math.exp((-La-42)/92); if(D<0)D=0; if(D>1)D=1;
  var Lw=CAT16[0]*XN + CAT16[1]*YN + CAT16[2]*ZN;
  var Mw=CAT16[3]*XN + CAT16[4]*YN + CAT16[5]*ZN;
  var Sw=CAT16[6]*XN + CAT16[7]*YN + CAT16[8]*ZN;
  HCT_RGBD=[ D*100/Lw + (1-D), D*100/Mw + (1-D), D*100/Sw + (1-D) ];
})();
function camResp(v){
  var t=Math.pow(HCT_FL*Math.abs(v)/100, 0.42);
  return (v<0?-1:1) * 400 * t/(t+27.13);
}
function camRespInv(r){
  var ar=Math.abs(r); if(ar>=399.999) ar=399.999;
  var p=27.13*ar/(400-ar);
  var t=Math.pow(p, 1/0.42);
  return (r<0?-1:1) * t*100/HCT_FL;
}
function applyHct(d, f){
  if(f===1) return;
  var xyz=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    xyzFromLinear(srgbLin255(d[i]),srgbLin255(d[i+1]),srgbLin255(d[i+2]),xyz);
    var X=xyz[0]*100, Y=xyz[1]*100, Z=xyz[2]*100;
    var L=(CAT16[0]*X + CAT16[1]*Y + CAT16[2]*Z)*HCT_RGBD[0];
    var M=(CAT16[3]*X + CAT16[4]*Y + CAT16[5]*Z)*HCT_RGBD[1];
    var S=(CAT16[6]*X + CAT16[7]*Y + CAT16[8]*Z)*HCT_RGBD[2];
    var rL=camResp(L), rM=camResp(M), rS=camResp(S);
    var Ap=OPP_MAT[0]*rL + OPP_MAT[1]*rM + OPP_MAT[2]*rS;
    var a=OPP_MAT[3]*rL + OPP_MAT[4]*rM + OPP_MAT[5]*rS;
    var b=OPP_MAT[6]*rL + OPP_MAT[7]*rM + OPP_MAT[8]*rS;
    a*=f; b*=f;
    rL=INV_OPP[0]*Ap + INV_OPP[1]*a + INV_OPP[2]*b;
    rM=INV_OPP[3]*Ap + INV_OPP[4]*a + INV_OPP[5]*b;
    rS=INV_OPP[6]*Ap + INV_OPP[7]*a + INV_OPP[8]*b;
    L=camRespInv(rL)/HCT_RGBD[0]; M=camRespInv(rM)/HCT_RGBD[1]; S=camRespInv(rS)/HCT_RGBD[2];
    var Xo=(INV_CAT16[0]*L + INV_CAT16[1]*M + INV_CAT16[2]*S)/100;
    var Yo=(INV_CAT16[3]*L + INV_CAT16[4]*M + INV_CAT16[5]*S)/100;
    var Zo=(INV_CAT16[6]*L + INV_CAT16[7]*M + INV_CAT16[8]*S)/100;
    linearFromXyz(Xo,Yo,Zo,d,i);
  }
}

var JZ_LMS=[0.41478972,0.579999,0.0146480, -0.2015100,1.120649,0.0531008, -0.0166008,0.264800,0.6684799];
var INV_JZ_LMS=inv3(JZ_LMS);
var JZ_OPP=[0.5,0.5,0, 3.524000,-4.066708,0.542708, 0.199076,1.096799,-1.295875];
var INV_JZ_OPP=inv3(JZ_OPP);
var PQ_M1=0.1593017578125, PQ_M2=78.84375, PQ_C1=0.8359375, PQ_C2=18.8515625, PQ_C3=18.6875;
function pqEnc(e){
  if(e<=0) return 0;
  var t=Math.pow(e,PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2*t)/(1 + PQ_C3*t), PQ_M2);
}
function pqDec(y){
  if(y<=0) return 0; if(y>1) y=1;
  var root=Math.pow(y, 1/PQ_M2);
  var den=PQ_C2 - root*PQ_C3;
  if(den<=0) return 1;
  var t=(root-PQ_C1)/den;
  if(t<=0) return 0;
  return Math.pow(t, 1/PQ_M1);
}
function applyJz(d, f){
  if(f===1) return;
  var xyz=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    xyzFromLinear(srgbLin(d[i]),srgbLin(d[i+1]),srgbLin(d[i+2]),xyz);
    var L=JZ_LMS[0]*xyz[0] + JZ_LMS[1]*xyz[1] + JZ_LMS[2]*xyz[2];
    var M=JZ_LMS[3]*xyz[0] + JZ_LMS[4]*xyz[1] + JZ_LMS[5]*xyz[2];
    var S=JZ_LMS[6]*xyz[0] + JZ_LMS[7]*xyz[1] + JZ_LMS[8]*xyz[2];
    var Lp=pqEnc(L), Mp=pqEnc(M), Sp=pqEnc(S);
    var Iz=JZ_OPP[0]*Lp + JZ_OPP[1]*Mp + JZ_OPP[2]*Sp;
    var Az=(JZ_OPP[3]*Lp + JZ_OPP[4]*Mp + JZ_OPP[5]*Sp)*f;
    var Bz=(JZ_OPP[6]*Lp + JZ_OPP[7]*Mp + JZ_OPP[8]*Sp)*f;
    Lp=INV_JZ_OPP[0]*Iz + INV_JZ_OPP[1]*Az + INV_JZ_OPP[2]*Bz;
    Mp=INV_JZ_OPP[3]*Iz + INV_JZ_OPP[4]*Az + INV_JZ_OPP[5]*Bz;
    Sp=INV_JZ_OPP[6]*Iz + INV_JZ_OPP[7]*Az + INV_JZ_OPP[8]*Bz;
    L=pqDec(Lp); M=pqDec(Mp); S=pqDec(Sp);
    var X=INV_JZ_LMS[0]*L + INV_JZ_LMS[1]*M + INV_JZ_LMS[2]*S;
    var Y=INV_JZ_LMS[3]*L + INV_JZ_LMS[4]*M + INV_JZ_LMS[5]*S;
    var Z=INV_JZ_LMS[6]*L + INV_JZ_LMS[7]*M + INV_JZ_LMS[8]*S;
    linearFromXyz(X,Y,Z,d,i);
  }
}

var UN=(4*XN)/(XN + 15*YN + 3*ZN), VN=(9*YN)/(XN + 15*YN + 3*ZN);
function applyHsluv(d, f){
  if(f===1) return;
  var xyz=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    xyzFromLinear(srgbLin255(d[i]),srgbLin255(d[i+1]),srgbLin255(d[i+2]),xyz);
    var X=xyz[0]*100, Y=xyz[1]*100, Z=xyz[2]*100;
    var den=X + 15*Y + 3*Z;
    if(den===0 || Y===0) continue;
    var up=4*X/den, vp=9*Y/den;
    var yr=Y/YN;
    var L= yr>D3 ? 116*Math.cbrt(yr)-16 : 903.3*yr;
    if(L<=0) continue;
    var du=up-UN, dv=vp-VN, fEff=f;
    if(f>1){
      if(dv<0) fEff=Math.min(fEff,(0.02-VN)/dv); else if(dv>0) fEff=Math.min(fEff,(0.65-VN)/dv);
      if(du<0) fEff=Math.min(fEff,(0.0-UN)/du); else if(du>0) fEff=Math.min(fEff,(0.65-UN)/du);
      if(fEff<0) fEff=0;
    }
    var us=13*L*du*fEff, vs=13*L*dv*fEff;
    var upo=us/(13*L)+UN, vpo=vs/(13*L)+VN;
    if(vpo===0) continue;
    var Yo= L>8 ? YN*Math.pow((L+16)/116,3) : L/903.3*YN;
    var Xo=Yo*(9*upo)/(4*vpo);
    var Zo=Yo*(12 - 3*upo - 20*vpo)/(4*vpo);
    linearFromXyz(Xo/100,Yo/100,Zo/100,d,i);
  }
}

var IPT_LMS=[0.4002,0.7076,-0.0808, -0.2263,1.1653,0.0457, 0,0,0.9182];
var INV_IPT_LMS=inv3(IPT_LMS);
var IPT_MAT=[0.4000,0.4000,0.2000, -4.4550,4.8510,-0.3960, 0.8056,-0.3572,-0.4484];
var INV_IPT_MAT=inv3(IPT_MAT);
function iptPow(v){ return v<0 ? -Math.pow(-v,0.43) : Math.pow(v,0.43); }
function iptPowInv(v){ return v<0 ? -Math.pow(-v,1/0.43) : Math.pow(v,1/0.43); }
function applyIpt(d, f){
  if(f===1) return;
  for(var i=0;i<d.length;i+=4){
    var R=srgbLin(d[i]), G=srgbLin(d[i+1]), B=srgbLin(d[i+2]);
    var Lp=iptPow(IPT_LMS[0]*R + IPT_LMS[1]*G + IPT_LMS[2]*B);
    var Mp=iptPow(IPT_LMS[3]*R + IPT_LMS[4]*G + IPT_LMS[5]*B);
    var Sp=iptPow(IPT_LMS[6]*R + IPT_LMS[7]*G + IPT_LMS[8]*B);
    var I=IPT_MAT[0]*Lp + IPT_MAT[1]*Mp + IPT_MAT[2]*Sp;
    var P=(IPT_MAT[3]*Lp + IPT_MAT[4]*Mp + IPT_MAT[5]*Sp)*f;
    var T=(IPT_MAT[6]*Lp + IPT_MAT[7]*Mp + IPT_MAT[8]*Sp)*f;
    Lp=INV_IPT_MAT[0]*I + INV_IPT_MAT[1]*P + INV_IPT_MAT[2]*T;
    Mp=INV_IPT_MAT[3]*I + INV_IPT_MAT[4]*P + INV_IPT_MAT[5]*T;
    Sp=INV_IPT_MAT[6]*I + INV_IPT_MAT[7]*P + INV_IPT_MAT[8]*T;
    var Lo=iptPowInv(Lp), Mo=iptPowInv(Mp), So=iptPowInv(Sp);
    var r=INV_IPT_LMS[0]*Lo + INV_IPT_LMS[1]*Mo + INV_IPT_LMS[2]*So;
    var g=INV_IPT_LMS[3]*Lo + INV_IPT_LMS[4]*Mo + INV_IPT_LMS[5]*So;
    var b=INV_IPT_LMS[6]*Lo + INV_IPT_LMS[7]*Mo + INV_IPT_LMS[8]*So;
    d[i]=clamp255(encode255(r)); d[i+1]=clamp255(encode255(g)); d[i+2]=clamp255(encode255(b));
  }
}

var AGX_IN=[0.84247906,0.07843360,0.07922375, 0.04232824,0.87846864,0.07916613, 0.04237565,0.07843360,0.87914297];
var AGX_OUT=[1.19687901,-0.09802088,-0.09902974, -0.05289685,1.15190313,-0.09896118, -0.05297164,-0.09804345,1.15107367];
var AGX_MIN_EV=-12.47393, AGX_RANGE=4.026069-(-12.47393);
function agxCurve(x){
  var x2=x*x, x3=x2*x, x4=x2*x2, x5=x4*x, x6=x3*x3;
  var y=15.5*x6 - 40.14*x5 + 31.96*x4 - 6.868*x3 + 0.4298*x2 + 0.1191*x - 0.00232;
  return y<0?0 : y>1?1 : y;
}
function applyAgx(d, s){
  if(s===0) return;
  for(var i=0;i<d.length;i+=4){
    var oR=d[i], oG=d[i+1], oB=d[i+2];
    var R=srgbLin(oR), G=srgbLin(oG), B=srgbLin(oB);
    var r=AGX_IN[0]*R + AGX_IN[1]*G + AGX_IN[2]*B;
    var g=AGX_IN[3]*R + AGX_IN[4]*G + AGX_IN[5]*B;
    var b=AGX_IN[6]*R + AGX_IN[7]*G + AGX_IN[8]*B;
    r=agxCurve(Math.min(1,Math.max(0,(Math.log2(Math.max(r,1e-10))-AGX_MIN_EV)/AGX_RANGE)));
    g=agxCurve(Math.min(1,Math.max(0,(Math.log2(Math.max(g,1e-10))-AGX_MIN_EV)/AGX_RANGE)));
    b=agxCurve(Math.min(1,Math.max(0,(Math.log2(Math.max(b,1e-10))-AGX_MIN_EV)/AGX_RANGE)));
    var ro=AGX_OUT[0]*r + AGX_OUT[1]*g + AGX_OUT[2]*b;
    var go=AGX_OUT[3]*r + AGX_OUT[4]*g + AGX_OUT[5]*b;
    var bo=AGX_OUT[6]*r + AGX_OUT[7]*g + AGX_OUT[8]*b;
    d[i]  = clamp255(oR*(1-s) + encode255(ro)*s);
    d[i+1]= clamp255(oG*(1-s) + encode255(go)*s);
    d[i+2]= clamp255(oB*(1-s) + encode255(bo)*s);
  }
}

function boxBlur(src,w,h,r){
  var tmp=new Float32Array(src.length), out=new Float32Array(src.length);
  var div=2*r+1, x,y,k,sum;
  for(y=0;y<h;y++){
    var row=y*w; sum=0;
    for(k=-r;k<=r;k++){ var cx=k<0?0:(k>=w?w-1:k); sum+=src[row+cx]; }
    tmp[row]=sum/div;
    for(x=1;x<w;x++){
      var add=x+r, sub=x-r-1;
      sum+=src[row+(add>=w?w-1:add)] - src[row+(sub<0?0:sub)];
      tmp[row+x]=sum/div;
    }
  }
  for(x=0;x<w;x++){
    sum=0;
    for(k=-r;k<=r;k++){ var cy=k<0?0:(k>=h?h-1:k); sum+=tmp[cy*w+x]; }
    out[x]=sum/div;
    for(y=1;y<h;y++){
      var addy=y+r, suby=y-r-1;
      sum+=tmp[(addy>=h?h-1:addy)*w+x] - tmp[(suby<0?0:suby)*w+x];
      out[y*w+x]=sum/div;
    }
  }
  return out;
}
function blur2(src,w,h,r){ return boxBlur(boxBlur(src,w,h,r),w,h,r); }
function lumArray(d){
  var n=d.length/4, lum=new Float32Array(n);
  for(var i=0,j=0;j<n;i+=4,j++) lum[j]=(0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2])/255;
  return lum;
}
function applyDehaze(d,w,h,a){
  if(a===0||!w||!h) return;
  var n=w*h;
  var R=new Float32Array(n), G=new Float32Array(n), B=new Float32Array(n);
  for(var i=0,j=0;j<n;i+=4,j++){ R[j]=d[i]/255; G[j]=d[i+1]/255; B[j]=d[i+2]/255; }
  var rad=Math.max(8,Math.min(80,Math.round(Math.min(w,h)*0.06)));
  var Rb=blur2(R,w,h,rad), Gb=blur2(G,w,h,rad), Bb=blur2(B,w,h,rad);
  var mR=0,mG=0,mB=0;
  for(var q=0;q<n;q++){ mR+=R[q]; mG+=G[q]; mB+=B[q]; }
  mR/=n; mG/=n; mB/=n;
  var k=a*0.85, satF= a>0 ? 1+a*0.30 : 1+a*0.25, veil=-a;
  for(var p=0,idx=0;p<n;p++,idx+=4){
    var r=R[p] + k*(Rb[p]-mR), g=G[p] + k*(Gb[p]-mG), b=B[p] + k*(Bb[p]-mB);
    var lum=0.299*r + 0.587*g + 0.114*b;
    r=lum+(r-lum)*satF; g=lum+(g-lum)*satF; b=lum+(b-lum)*satF;
    if(veil>0){ var vv=veil*0.16; r=r*(1-veil*0.22)+vv; g=g*(1-veil*0.22)+vv; b=b*(1-veil*0.22)+vv; }
    d[idx]=clamp255(r*255); d[idx+1]=clamp255(g*255); d[idx+2]=clamp255(b*255);
  }
}
function applyClarity(d,w,h,a){
  if(a===0||!w||!h) return;
  var lum=lumArray(d);
  var rad=Math.max(4,Math.min(40,Math.round(Math.min(w,h)*0.025)));
  var lb=blur2(lum,w,h,rad);
  for(var p=0,idx=0;p<lum.length;p++,idx+=4){
    var L=lum[p];
    var mid=4*L*(1-L); if(mid<0)mid=0; if(mid>1)mid=1;
    var target=L + a*(L-lb[p])*mid*1.8;
    if(target<0)target=0; if(target>1)target=1;
    if(L>0.004){
      var sc=target/L;
      d[idx]=clamp255(d[idx]*sc); d[idx+1]=clamp255(d[idx+1]*sc); d[idx+2]=clamp255(d[idx+2]*sc);
    }else{
      var add=(target-L)*255;
      d[idx]=clamp255(d[idx]+add); d[idx+1]=clamp255(d[idx+1]+add); d[idx+2]=clamp255(d[idx+2]+add);
    }
  }
}

/* ---------- Nuevos filtros (corrección, cine, perceptuales, HDR) ---------- */
function hslToRgb255(h,s,l){
  h=((h%360)+360)%360/360; s/=100; l/=100;
  var c=(1-Math.abs(2*l-1))*s, x=c*(1-Math.abs((h*6)%2-1)), m=l-c/2, r=0,g=0,b=0;
  if(h<1/6){r=c;g=x;} else if(h<2/6){r=x;g=c;} else if(h<3/6){g=c;b=x;} else if(h<4/6){g=x;b=c;} else if(h<5/6){r=x;b=c;} else {r=c;b=x;}
  return [(r+m)*255,(g+m)*255,(b+m)*255];
}
function applyExposure(d, ev){
  if(ev===0) return;
  var mult=Math.pow(2,ev);
  for(var i=0;i<d.length;i+=4){
    d[i]  = clamp255(encode255(srgbLin255(d[i])*mult));
    d[i+1]= clamp255(encode255(srgbLin255(d[i+1])*mult));
    d[i+2]= clamp255(encode255(srgbLin255(d[i+2])*mult));
  }
}
function smooth01(t){ t=t<0?0:t>1?1:t; return t*t*(3-2*t); }
function applyToneZone(d, v, mode){
  if(v===0) return;
  for(var i=0;i<d.length;i+=4){
    var l=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])/255, w=0;
    if(mode==="high") w=smooth01((l-0.35)/0.65);
    else if(mode==="shad") w=Math.pow(1-l,2.2);
    else if(mode==="white") w=smooth01((l-0.68)/0.32);
    else w=smooth01((0.32-l)/0.32);
    if(w===0) continue;
    var f=1+v*0.55*w, lift=(mode==="shad"||mode==="black")? v*w*20 : 0;
    d[i]=clamp255(d[i]*f+lift); d[i+1]=clamp255(d[i+1]*f+lift); d[i+2]=clamp255(d[i+2]*f+lift);
  }
}
function applyGamma(d, g){
  if(g===1) return;
  var exp=1/g;
  for(var i=0;i<d.length;i+=4){
    d[i]  = clamp255(255*Math.pow(d[i]/255,exp));
    d[i+1]= clamp255(255*Math.pow(d[i+1]/255,exp));
    d[i+2]= clamp255(255*Math.pow(d[i+2]/255,exp));
  }
}
function applyTintGM(d, v){
  if(v===0) return;
  var s=v*18;
  for(var i=0;i<d.length;i+=4){ d[i]=clamp255(d[i]+s); d[i+1]=clamp255(d[i+1]-s); d[i+2]=clamp255(d[i+2]+s); }
}
function applyHueRotHSL(d, deg){
  if(deg===0) return;
  var shift=((deg%360)+360)%360;
  for(var i=0;i<d.length;i+=4){
    var r=d[i]/255,g=d[i+1]/255,b=d[i+2]/255;
    var mx=Math.max(r,g,b), mn=Math.min(r,g,b), dl=mx-mn, L=(mx+mn)/2, S= dl===0?0 : dl/(1-Math.abs(2*L-1)||1), H=0;
    if(dl!==0){
      if(mx===r) H=60*(((g-b)/dl)%6); else if(mx===g) H=60*((b-r)/dl+2); else H=60*((r-g)/dl+4);
      if(H<0)H+=360;
    }
    H=(H+shift)%360;
    var rgb=hslToRgb255(H,S*100,L*100);
    d[i]=clamp255(rgb[0]); d[i+1]=clamp255(rgb[1]); d[i+2]=clamp255(rgb[2]);
  }
}
function applyHueRotOK(d, deg){
  if(deg===0) return;
  var rad=deg*Math.PI/180, cs=Math.cos(rad), sn=Math.sin(rad), lab=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    srgbToOklab(d[i],d[i+1],d[i+2],lab);
    var a=lab[1]*cs-lab[2]*sn, b=lab[1]*sn+lab[2]*cs;
    oklabToSrgb(lab[0],a,b,d,i);
  }
}
function applySplitTone(d, amt, hue){
  if(amt===0) return;
  var sh=hslToRgb255(hue,65,55), hi=hslToRgb255(hue+180,65,55), k=amt*0.5;
  for(var i=0;i<d.length;i+=4){
    var l=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])/255;
    d[i]  = clamp255(d[i]  + ((sh[0]-128)*(1-l)+(hi[0]-128)*l)*k);
    d[i+1]= clamp255(d[i+1]+ ((sh[1]-128)*(1-l)+(hi[1]-128)*l)*k);
    d[i+2]= clamp255(d[i+2]+ ((sh[2]-128)*(1-l)+(hi[2]-128)*l)*k);
  }
}
function applyDuotone(d, amt, hue){
  if(amt===0) return;
  var dk=hslToRgb255(hue,60,16), lt=hslToRgb255(hue+45,75,84);
  for(var i=0;i<d.length;i+=4){
    var l=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])/255;
    d[i]  = clamp255(d[i]*(1-amt)  + (dk[0]+(lt[0]-dk[0])*l)*amt);
    d[i+1]= clamp255(d[i+1]*(1-amt)+ (dk[1]+(lt[1]-dk[1])*l)*amt);
    d[i+2]= clamp255(d[i+2]*(1-amt)+ (dk[2]+(lt[2]-dk[2])*l)*amt);
  }
}
function applyCam16(d, f){ if(f!==1) applyHct(d,f); }
var CAT02=[0.7328,0.4296,-0.1624, -0.7036,1.6975,0.0061, 0.0030,0.0136,0.9834];
var INV_CAT02=inv3(CAT02);
var CAM02_RGBD=[1,1,1];
(function(){
  var D=0.9, Lw=CAT02[0]*XN+CAT02[1]*YN+CAT02[2]*ZN, Mw=CAT02[3]*XN+CAT02[4]*YN+CAT02[5]*ZN, Sw=CAT02[6]*XN+CAT02[7]*YN+CAT02[8]*ZN;
  CAM02_RGBD=[D*100/Lw+(1-D), D*100/Mw+(1-D), D*100/Sw+(1-D)];
})();
function applyCiecam02(d, f){
  if(f===1) return;
  var xyz=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    xyzFromLinear(srgbLin(d[i]),srgbLin(d[i+1]),srgbLin(d[i+2]),xyz);
    var X=xyz[0]*100, Y=xyz[1]*100, Z=xyz[2]*100;
    var L=(CAT02[0]*X+CAT02[1]*Y+CAT02[2]*Z)*CAM02_RGBD[0];
    var M=(CAT02[3]*X+CAT02[4]*Y+CAT02[5]*Z)*CAM02_RGBD[1];
    var S=(CAT02[6]*X+CAT02[7]*Y+CAT02[8]*Z)*CAM02_RGBD[2];
    var rL=camResp(L), rM=camResp(M), rS=camResp(S);
    var Ap=OPP_MAT[0]*rL+OPP_MAT[1]*rM+OPP_MAT[2]*rS;
    var a=(OPP_MAT[3]*rL+OPP_MAT[4]*rM+OPP_MAT[5]*rS)*f;
    var b=(OPP_MAT[6]*rL+OPP_MAT[7]*rM+OPP_MAT[8]*rS)*f;
    rL=INV_OPP[0]*Ap+INV_OPP[1]*a+INV_OPP[2]*b; rM=INV_OPP[3]*Ap+INV_OPP[4]*a+INV_OPP[5]*b; rS=INV_OPP[6]*Ap+INV_OPP[7]*a+INV_OPP[8]*b;
    L=camRespInv(rL)/CAM02_RGBD[0]; M=camRespInv(rM)/CAM02_RGBD[1]; S=camRespInv(rS)/CAM02_RGBD[2];
    linearFromXyz((INV_CAT02[0]*L+INV_CAT02[1]*M+INV_CAT02[2]*S)/100,(INV_CAT02[3]*L+INV_CAT02[4]*M+INV_CAT02[5]*S)/100,(INV_CAT02[6]*L+INV_CAT02[7]*M+INV_CAT02[8]*S)/100,d,i);
  }
}
var ICTCP_LMS=[0.3592,0.6976,-0.0358, -0.1922,1.1004,0.0755, 0.0070,0.0749,0.8434];
var INV_ICTCP_LMS=inv3(ICTCP_LMS);
var ICTCP_M=[0.5,0.5,0, 1.6138,-3.3235,1.7097, 4.3782,-4.6392,0.2610];
var INV_ICTCP_M=inv3(ICTCP_M);
function applyIctcp(d, f){
  if(f===1) return;
  for(var i=0;i<d.length;i+=4){
    var R=srgbLin(d[i]), G=srgbLin(d[i+1]), B=srgbLin(d[i+2]);
    var Lp=pqEnc(ICTCP_LMS[0]*R+ICTCP_LMS[1]*G+ICTCP_LMS[2]*B);
    var Mp=pqEnc(ICTCP_LMS[3]*R+ICTCP_LMS[4]*G+ICTCP_LMS[5]*B);
    var Sp=pqEnc(ICTCP_LMS[6]*R+ICTCP_LMS[7]*G+ICTCP_LMS[8]*B);
    var I=ICTCP_M[0]*Lp+ICTCP_M[1]*Mp+ICTCP_M[2]*Sp;
    var Ct=(ICTCP_M[3]*Lp+ICTCP_M[4]*Mp+ICTCP_M[5]*Sp)*f;
    var Cp=(ICTCP_M[6]*Lp+ICTCP_M[7]*Mp+ICTCP_M[8]*Sp)*f;
    Lp=INV_ICTCP_M[0]*I+INV_ICTCP_M[1]*Ct+INV_ICTCP_M[2]*Cp;
    Mp=INV_ICTCP_M[3]*I+INV_ICTCP_M[4]*Ct+INV_ICTCP_M[5]*Cp;
    Sp=INV_ICTCP_M[6]*I+INV_ICTCP_M[7]*Ct+INV_ICTCP_M[8]*Cp;
    var Lo=pqDec(Lp), Mo=pqDec(Mp), So=pqDec(Sp);
    d[i]  = clamp255(encode255(INV_ICTCP_LMS[0]*Lo+INV_ICTCP_LMS[1]*Mo+INV_ICTCP_LMS[2]*So));
    d[i+1]= clamp255(encode255(INV_ICTCP_LMS[3]*Lo+INV_ICTCP_LMS[4]*Mo+INV_ICTCP_LMS[5]*So));
    d[i+2]= clamp255(encode255(INV_ICTCP_LMS[6]*Lo+INV_ICTCP_LMS[7]*Mo+INV_ICTCP_LMS[8]*So));
  }
}
function applyLchClarity(d, v){
  if(v===0) return;
  var n=d.length, count=n/4, Ls=new Float32Array(count), as=new Float32Array(count), bs=new Float32Array(count), p=0;
  for(var i=0;i<n;i+=4){
    var R=srgbLin(d[i]), G=srgbLin(d[i+1]), B=srgbLin(d[i+2]);
    var X=(0.4124564*R+0.3575761*G+0.1804375*B)*100, Y=(0.2126729*R+0.7151522*G+0.0721750*B)*100, Z=(0.0193339*R+0.1191920*G+0.9503041*B)*100;
    var fx=labF(X/XN), fy=labF(Y/YN), fz=labF(Z/ZN);
    Ls[p]=116*fy-16; as[p]=500*(fx-fy); bs[p]=200*(fy-fz); p++;
  }
  p=0;
  for(var j=0;j<n;j+=4){
    var t=Ls[p]/100, tn=t + v*3*t*(1-t)*(t-0.5); if(tn<0)tn=0; if(tn>1)tn=1;
    var L=tn*100, a2=as[p], b2=bs[p];
    var fy2=(L+16)/116, fx2=fy2+a2/500, fz2=fy2-b2/200;
    linearFromXyz(labFInv(fx2)*XN/100, labFInv(fy2)*YN/100, labFInv(fz2)*ZN/100, d, j);
    p++;
  }
}
var BFD=[0.8951,0.2664,-0.1614, -0.7502,1.7135,0.0367, 0.0389,-0.0685,1.0296];
var INV_BFD=inv3(BFD);
function applyBradford(d, v){
  if(v===0) return;
  var sr=1+0.14*v, sg=1, sb=1-0.20*v, xyz=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    xyzFromLinear(srgbLin(d[i]),srgbLin(d[i+1]),srgbLin(d[i+2]),xyz);
    var X=xyz[0]*100, Y=xyz[1]*100, Z=xyz[2]*100;
    var L=(BFD[0]*X+BFD[1]*Y+BFD[2]*Z)*sr, M=(BFD[3]*X+BFD[4]*Y+BFD[5]*Z)*sg, S=(BFD[6]*X+BFD[7]*Y+BFD[8]*Z)*sb;
    linearFromXyz((INV_BFD[0]*L+INV_BFD[1]*M+INV_BFD[2]*S)/100,(INV_BFD[3]*L+INV_BFD[4]*M+INV_BFD[5]*S)/100,(INV_BFD[6]*L+INV_BFD[7]*M+INV_BFD[8]*S)/100,d,i);
  }
}
function applySatLum(d, v){
  if(v===0) return;
  for(var i=0;i<d.length;i+=4){
    var r=d[i], g=d[i+1], b=d[i+2], lum=0.299*r+0.587*g+0.114*b, l=lum/255;
    var f=1 + v*1.5*(1-l)*(0.35+0.65*(1-l)); if(f<0)f=0;
    d[i]=clamp255(lum+(r-lum)*f); d[i+1]=clamp255(lum+(g-lum)*f); d[i+2]=clamp255(lum+(b-lum)*f);
  }
}
function acesCurve(x){ var y=x*(2.51*x+0.03)/(x*(2.43*x+0.59)+0.14); return y<0?0:y>1?1:y; }
function applyAces(d, amt){
  if(amt===0) return;
  for(var i=0;i<d.length;i+=4){
    for(var c=0;c<3;c++){
      var lin=srgbLin255(d[i+c]), out=encode255(acesCurve(lin*1.6)/1.0);
      d[i+c]=clamp255(d[i+c]*(1-amt)+clamp255(out)*amt);
    }
  }
}
function filmicCurve(x){ var y=(x*(6.2*x+0.5))/(x*(6.2*x+1.7)+0.06); return y<0?0:y>1?1:y; }
function applyFilmic(d, amt){
  if(amt===0) return;
  var white=filmicCurve(11.2);
  for(var i=0;i<d.length;i+=4){
    for(var c=0;c<3;c++){
      var lin=srgbLin255(d[i+c]), out=encode255(filmicCurve(lin*3.2)/white);
      d[i+c]=clamp255(d[i+c]*(1-amt)+clamp255(out)*amt);
    }
  }
}
function hableCurve(x){ return (x*(0.15*x+0.05)+0.004)/(x*(0.15*x+0.5)+0.06) - 0.02/0.30; }
function applyReinhard(d, amt){
  if(amt===0) return;
  var w=hableCurve(11.2);
  for(var i=0;i<d.length;i+=4){
    for(var c=0;c<3;c++){
      var lin=srgbLin255(d[i+c]);
      var hab=encode255(Math.max(0,hableCurve(lin*3.0))/w);
      var rei=encode255(lin/(1+lin)*1.9);
      var out=(hab+rei)/2;
      d[i+c]=clamp255(d[i+c]*(1-amt)+clamp255(out)*amt);
    }
  }
}
function channelArrays(d,w,h){
  var n=w*h, R=new Float32Array(n), G=new Float32Array(n), B=new Float32Array(n);
  for(var i=0,j=0;j<n;i+=4,j++){ R[j]=d[i]/255; G[j]=d[i+1]/255; B[j]=d[i+2]/255; }
  return [R,G,B];
}
function applyGrain(d, amt){
  if(amt===0) return;
  var amp=amt*44;
  for(var i=0;i<d.length;i+=4){
    var l=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])/255;
    var g=(Math.random()-0.5)*amp*(1.15-Math.abs(l-0.5));
    d[i]=clamp255(d[i]+g); d[i+1]=clamp255(d[i+1]+g); d[i+2]=clamp255(d[i+2]+g);
  }
}
function applyVignette(d,w,h,amt){
  if(amt===0||!w||!h) return;
  var cx=(w-1)/2, cy=(h-1)/2, maxD=Math.sqrt(cx*cx+cy*cy);
  for(var y=0;y<h;y++) for(var x=0;x<w;x++){
    var dx=(x-cx)/maxD, dy=(y-cy)/maxD, r2=dx*dx+dy*dy;
    var f=1 - amt*0.6*Math.pow(r2,1.4); if(f<0.05)f=0.05;
    var idx=(y*w+x)*4;
    d[idx]=clamp255(d[idx]*f); d[idx+1]=clamp255(d[idx+1]*f); d[idx+2]=clamp255(d[idx+2]*f);
  }
}
function applyCA(d,w,h,amt){
  if(amt===0||!w||!h) return;
  var src=new Uint8ClampedArray(d), cx=(w-1)/2, cy=(h-1)/2;
  function sample(x,y,c){ x=x<0?0:x>=w?w-1:x; y=y<0?0:y>=h?h-1:y; return src[(y*w+x)*4+c]; }
  for(var y=0;y<h;y++) for(var x=0;x<w;x++){
    var dx=(x-cx)/cx, dy=(y-cy)/cy, r=Math.sqrt(dx*dx+dy*dy), s=amt*r;
    var idx=(y*w+x)*4;
    d[idx]  = sample(Math.round(x+dx*s), Math.round(y+dy*s), 0);
    d[idx+2]= sample(Math.round(x-dx*s), Math.round(y-dy*s), 2);
  }
}
function applyAWB(d, amt){
  if(amt===0) return;
  var n=d.length/4, sR=0,sG=0,sB=0;
  for(var i=0;i<d.length;i+=4){ sR+=d[i]; sG+=d[i+1]; sB+=d[i+2]; }
  if(!n) return;
  var mR=sR/n, mG=sG/n, mB=sB/n, avg=(mR+mG+mB)/3;
  if(mR<1||mG<1||mB<1) return;
  var gR=1+(avg/mR-1)*amt, gG=1+(avg/mG-1)*amt, gB=1+(avg/mB-1)*amt;
  for(var j=0;j<d.length;j+=4){ d[j]=clamp255(d[j]*gR); d[j+1]=clamp255(d[j+1]*gG); d[j+2]=clamp255(d[j+2]*gB); }
}
function applyFreqSep(d,w,h,amt){
  if(amt===0||!w||!h) return;
  var ch=channelArrays(d,w,h), rad=Math.max(2,Math.min(24,Math.round(Math.min(w,h)*0.02)));
  var bl=[blur2(ch[0],w,h,rad), blur2(ch[1],w,h,rad), blur2(ch[2],w,h,rad)];
  for(var p=0,idx=0;p<w*h;p++,idx+=4){
    for(var c=0;c<3;c++){ d[idx+c]=clamp255((ch[c][p] + amt*1.7*(ch[c][p]-bl[c][p]))*255); }
  }
}
function applyMicro(d,w,h,amt){
  if(amt===0||!w||!h) return;
  var lum=lumArray(d), lb=blur2(lum,w,h,2);
  for(var p=0,idx=0;p<lum.length;p++,idx+=4){
    var L=lum[p], target=L + amt*(L-lb[p])*1.5;
    if(target<0)target=0; if(target>1)target=1;
    if(L>0.004){ var sc=target/L; d[idx]=clamp255(d[idx]*sc); d[idx+1]=clamp255(d[idx+1]*sc); d[idx+2]=clamp255(d[idx+2]*sc); }
    else { var add=(target-L)*255; d[idx]=clamp255(d[idx]+add); d[idx+1]=clamp255(d[idx+1]+add); d[idx+2]=clamp255(d[idx+2]+add); }
  }
}
function applyFilmSim(d, amt, variant){
  if(amt===0) return;
  var varr=Math.max(0,Math.min(2,Math.round(variant)));
  for(var i=0;i<d.length;i+=4){
    var r=d[i], g=d[i+1], b=d[i+2], lum=0.299*r+0.587*g+0.114*b, nr=r, ng=g, nb=b;
    if(varr===0){ nr=r*1.03+7; ng=g*1.0+3; nb=b*0.94-3; var f0=0.92; nr=lum+(nr-lum)*f0; ng=lum+(ng-lum)*f0; nb=lum+(nb-lum)*f0; }
    else if(varr===1){ var f1=1.35; nr=lum+(r-lum)*f1; ng=lum+(g-lum)*f1*1.05; nb=lum+(b-lum)*f1; nr=nr*1.04; nb=nb*1.05; }
    else { var sh=(1-lum/255), hi=lum/255; nr=r + (hi*14 - sh*6); ng=g + (sh*10 - hi*2); nb=b + (sh*16 - hi*6); var f2=1.1; nr=lum+(nr-lum)*f2; ng=lum+(ng-lum)*f2; nb=lum+(nb-lum)*f2; }
    d[i]=clamp255(r*(1-amt)+nr*amt); d[i+1]=clamp255(g*(1-amt)+ng*amt); d[i+2]=clamp255(b*(1-amt)+nb*amt);
  }
}
function applyHdrPq(d, amt){
  if(amt===0) return;
  for(var i=0;i<d.length;i+=4){
    for(var c=0;c<3;c++){
      var lin=srgbLin(d[i+c]);
      var comp=1-Math.exp(-lin*2.4); comp=comp/ (1-Math.exp(-2.4)) ;
      var out=encode255(comp);
      d[i+c]=clamp255(d[i+c]*(1-amt)+clamp255(out)*amt);
    }
  }
}
var BAYER8=[0,32,8,40,2,34,10,42, 48,16,56,24,50,18,58,26, 12,44,4,36,14,46,6,38, 60,28,52,20,62,30,54,22, 3,35,11,43,1,33,9,41, 51,19,59,27,49,17,57,25, 15,47,7,39,13,45,5,37, 63,31,55,23,61,29,53,21];
function applyDither(d,w,h,amt){
  if(amt===0||!w||!h) return;
  var amp=amt*15;
  for(var y=0;y<h;y++) for(var x=0;x<w;x++){
    var idx=(y*w+x)*4, dv=(BAYER8[(y%8)*8+(x%8)]/64-0.5)*amp;
    d[idx]=clamp255(d[idx]+dv); d[idx+1]=clamp255(d[idx+1]+dv); d[idx+2]=clamp255(d[idx+2]+dv);
  }
}
function applySelDesat(d, amt, keepHue){
  if(amt===0) return;
  for(var i=0;i<d.length;i+=4){
    var r=d[i], g=d[i+1], b=d[i+2];
    var mx=Math.max(r,g,b), mn=Math.min(r,g,b), dl=mx-mn, H=0;
    if(dl>4){
      if(mx===r) H=60*(((g-b)/dl)%6); else if(mx===g) H=60*((b-r)/dl+2); else H=60*((r-g)/dl+4);
      if(H<0)H+=360;
    } else continue;
    var diff=Math.abs(H-keepHue); if(diff>180) diff=360-diff;
    var keep=smooth01((75-diff)/75); if(keep<0)keep=0; if(keep>1)keep=1;
    var desat=amt*(1-keep); if(desat<=0) continue;
    var lum=0.299*r+0.587*g+0.114*b;
    d[i]=clamp255(r+(lum-r)*desat); d[i+1]=clamp255(g+(lum-g)*desat); d[i+2]=clamp255(b+(lum-b)*desat);
  }
}

/* ==================================================================
   26 filtros tradicionales nuevos (estándar industrial / SOTA) —
   reimplementados desde la referencia en Python que generó las
   previews aprobadas. Cada uno: 1 gen de intensidad 0-1, default 0;
   a intensidad 1 reproduce el efecto completo de su preview.
   ================================================================== */
function c01(v){ return v<0?0 : v>1?1 : v; }
function sCurve01(x, k){
  x=c01(x);
  var ss=x*x*(3-2*x);
  return c01((1-0.55*k)*x + 0.55*k*ss);
}
function lum709(r,g,b){ return 0.2126*r + 0.7152*g + 0.0722*b; }
function blurChannels(ch,w,h,r){
  return [blur2(ch[0],w,h,r), blur2(ch[1],w,h,r), blur2(ch[2],w,h,r)];
}
function blendFull(d, idx, fr, fg, fb, amt){
  d[idx]  = clamp255(d[idx]  *(1-amt) + fr*255*amt);
  d[idx+1]= clamp255(d[idx+1]*(1-amt) + fg*255*amt);
  d[idx+2]= clamp255(d[idx+2]*(1-amt) + fb*255*amt);
}
/* 01 · Retinex MSRCR — multi-escala logarítmico + restauración de color */
function applyRetinex(d,w,h,amt){
  if(amt===0||!w||!h) return;
  var n=w*h, ch=channelArrays(d,w,h), md=Math.min(w,h);
  var radii=[Math.max(2,Math.round(md*0.02)), Math.max(3,Math.round(md*0.10)), Math.max(4,Math.min(60,Math.round(md*0.30)))];
  var blurs=[blurChannels(ch,w,h,radii[0]), blurChannels(ch,w,h,radii[1]), blurChannels(ch,w,h,radii[2])];
  var ret=[new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  var mn=Infinity, mx=-Infinity;
  for(var c=0;c<3;c++){
    for(var p=0;p<n;p++){
      var v=(Math.log1p(ch[c][p]*10)-Math.log1p(blurs[0][c][p]*10)
           + Math.log1p(ch[c][p]*10)-Math.log1p(blurs[1][c][p]*10)
           + Math.log1p(ch[c][p]*10)-Math.log1p(blurs[2][c][p]*10))/3;
      ret[c][p]=v;
      if(v<mn)mn=v; if(v>mx)mx=v;
    }
  }
  var range=(mx-mn)||1;
  for(var q=0,idx=0;q<n;q++,idx+=4){
    blendFull(d, idx,
      0.5*c01((ret[0][q]-mn)/range)+0.5*ch[0][q],
      0.5*c01((ret[1][q]-mn)/range)+0.5*ch[1][q],
      0.5*c01((ret[2][q]-mn)/range)+0.5*ch[2][q], amt);
  }
}
/* 03 · Local Laplacian — detalle local amplificado (Paris et al.) */
function applyLocalLaplacian(d,w,h,amt){
  if(amt===0||!w||!h) return;
  var ch=channelArrays(d,w,h), bl=blurChannels(ch,w,h,3);
  for(var p=0,idx=0;p<w*h;p++,idx+=4){
    blendFull(d, idx,
      c01(bl[0][p]+(ch[0][p]-bl[0][p])*2.2),
      c01(bl[1][p]+(ch[1][p]-bl[1][p])*2.2),
      c01(bl[2][p]+(ch[2][p]-bl[2][p])*2.2), amt);
  }
}
/* 04 · Guided Detail — detalle del guided filter (He et al.) */
function applyGuidedDetail(d,w,h,amt){
  if(amt===0||!w||!h) return;
  var ch=channelArrays(d,w,h), bl=blurChannels(ch,w,h,2);
  for(var p=0,idx=0;p<w*h;p++,idx+=4){
    blendFull(d, idx,
      c01(ch[0][p]+(ch[0][p]-bl[0][p])*1.2),
      c01(ch[1][p]+(ch[1][p]-bl[1][p])*1.2),
      c01(ch[2][p]+(ch[2][p]-bl[2][p])*1.2), amt);
  }
}
/* 09 · Auto Levels — estiramiento 1–99% por canal */
function applyAutoLevels(d, amt){
  if(amt===0) return;
  var total=d.length/4; if(!total) return;
  var hist=[new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  for(var i=0;i<d.length;i+=4){ hist[0][d[i]]++; hist[1][d[i+1]]++; hist[2][d[i+2]]++; }
  var lo=[0,0,0], hi=[255,255,255];
  for(var c=0;c<3;c++){
    var cum=0, v;
    for(v=0;v<256;v++){ cum+=hist[c][v]; if(cum>=total*0.01){ lo[c]=v; break; } }
    cum=0;
    for(v=0;v<256;v++){ cum+=hist[c][v]; if(cum>=total*0.99){ hi[c]=v; break; } }
    if(hi[c]<=lo[c]){ lo[c]=0; hi[c]=255; }
  }
  for(var j=0;j<d.length;j+=4){
    for(var k=0;k<3;k++){
      var full=c01((d[j+k]/255 - lo[k]/255)/((hi[k]-lo[k])/255))*255;
      d[j+k]=clamp255(d[j+k]*(1-amt) + full*amt);
    }
  }
}
/* 10 · Curva S RGB — curva S fílmica suave */
function applySCurveRGB(d, amt){
  if(amt===0) return;
  var k=0.9*amt;
  for(var i=0;i<d.length;i+=4){
    d[i]  = clamp255(sCurve01(d[i]/255, k)*255);
    d[i+1]= clamp255(sCurve01(d[i+1]/255, k)*255);
    d[i+2]= clamp255(sCurve01(d[i+2]/255, k)*255);
  }
}
/* 13 · Kodak 2383 — curva S + cálido + saturación (print film) */
function applyKodak2383(d, amt){
  if(amt===0) return;
  for(var i=0;i<d.length;i+=4){
    var r=sCurve01(d[i]/255,0.7)*1.06, g=sCurve01(d[i+1]/255,0.7), b=sCurve01(d[i+2]/255,0.7)*0.94;
    var L=lum709(r,g,b);
    blendFull(d, i, c01(L+(r-L)*1.15), c01(L+(g-L)*1.15), c01(L+(b-L)*1.15), amt);
  }
}
/* 16/17 · Tone mapping logarítmico sobre luminancia (Mantiuk / Drago) */
function applyLogToneMap(d, amt, scaleK, base, wRatio){
  if(amt===0) return;
  var norm=Math.log1p(scaleK);
  for(var i=0;i<d.length;i+=4){
    var L=lum709(d[i]/255, d[i+1]/255, d[i+2]/255);
    var ratio= L>0.01 ? (Math.log1p(L*scaleK)/norm)/L : 1;
    var f=1-amt + amt*(base + wRatio*ratio);
    d[i]=clamp255(d[i]*f); d[i+1]=clamp255(d[i+1]*f); d[i+2]=clamp255(d[i+2]*f);
  }
}
function applyMantiuk(d, amt){ applyLogToneMap(d, amt, 9, 0.55, 0.45); }
function applyDrago(d, amt){ applyLogToneMap(d, amt, 5, 0.40, 0.60); }
/* 19/20/21 · Balances de blancos por ganancias (white-patch / gray-world / shades of gray) */
function wbGains(d, mode){
  var total=d.length/4; if(!total) return null;
  var m=[0,0,0], c, i;
  if(mode==="white"){
    var hist=[new Float64Array(256), new Float64Array(256), new Float64Array(256)];
    for(i=0;i<d.length;i+=4){ hist[0][d[i]]++; hist[1][d[i+1]]++; hist[2][d[i+2]]++; }
    for(c=0;c<3;c++){
      var cum=0;
      for(var v=0;v<256;v++){ cum+=hist[c][v]; if(cum>=total*0.99){ m[c]=v/255; break; } }
      if(m[c]<0.01) return null;
    }
    return [1/m[0], 1/m[1], 1/m[2]];
  }
  if(mode==="shades"){
    var s6=[0,0,0];
    for(i=0;i<d.length;i+=4){ for(c=0;c<3;c++){ var x=d[i+c]/255; s6[c]+=x*x*x*x*x*x; } }
    for(c=0;c<3;c++) m[c]=Math.pow(s6[c]/total, 1/6);
  }else{
    for(i=0;i<d.length;i+=4){ m[0]+=d[i]/255; m[1]+=d[i+1]/255; m[2]+=d[i+2]/255; }
    for(c=0;c<3;c++) m[c]/=total;
  }
  if(m[0]<0.01||m[1]<0.01||m[2]<0.01) return null;
  var avg=(m[0]+m[1]+m[2])/3;
  return [avg/m[0], avg/m[1], avg/m[2]];
}
function applyWBGains(d, amt, mode){
  if(amt===0) return;
  var g=wbGains(d, mode); if(!g) return;
  var gr=1+(g[0]-1)*amt, gg=1+(g[1]-1)*amt, gb=1+(g[2]-1)*amt;
  for(var i=0;i<d.length;i+=4){ d[i]=clamp255(d[i]*gr); d[i+1]=clamp255(d[i+1]*gg); d[i+2]=clamp255(d[i+2]*gb); }
}
/* 22 · von Kries CAT — escala LMS sobre RGB lineal (matriz IPT) */
function applyVonKries(d, amt){
  if(amt===0) return;
  var sr=1+0.05*amt, sb=1-0.08*amt;
  for(var i=0;i<d.length;i+=4){
    var R=srgbLin(d[i]), G=srgbLin(d[i+1]), B=srgbLin(d[i+2]);
    var L=(IPT_LMS[0]*R + IPT_LMS[1]*G + IPT_LMS[2]*B)*sr;
    var M= IPT_LMS[3]*R + IPT_LMS[4]*G + IPT_LMS[5]*B;
    var S=(IPT_LMS[6]*R + IPT_LMS[7]*G + IPT_LMS[8]*B)*sb;
    var r=INV_IPT_LMS[0]*L + INV_IPT_LMS[1]*M + INV_IPT_LMS[2]*S;
    var g=INV_IPT_LMS[3]*L + INV_IPT_LMS[4]*M + INV_IPT_LMS[5]*S;
    var b=INV_IPT_LMS[6]*L + INV_IPT_LMS[7]*M + INV_IPT_LMS[8]*S;
    d[i]=clamp255(encode255(r)); d[i+1]=clamp255(encode255(g)); d[i+2]=clamp255(encode255(b));
  }
}
/* 23 · YCbCr Chroma — croma BT.709 ×1.45 a intensidad 1 */
function applyYCbCrChroma(d, amt){
  if(amt===0) return;
  var f=1+0.45*amt;
  for(var i=0;i<d.length;i+=4){
    var r=d[i]/255, g=d[i+1]/255, b=d[i+2]/255;
    var Y=lum709(r,g,b);
    var cb=0.5 + ((b-Y)*0.564)*f, cr=0.5 + ((r-Y)*0.713)*f;
    d[i]  = clamp255((Y + 1.402*(cr-0.5))*255);
    d[i+1]= clamp255((Y - 0.344*(cb-0.5) - 0.714*(cr-0.5))*255);
    d[i+2]= clamp255((Y + 1.772*(cb-0.5))*255);
  }
}
/* 24 · ProPhoto Gamut — saturación ×1.5 en RGB lineal a intensidad 1 */
function applyProPhoto(d, amt){
  if(amt===0) return;
  var f=1+0.5*amt;
  for(var i=0;i<d.length;i+=4){
    var R=srgbLin(d[i]), G=srgbLin(d[i+1]), B=srgbLin(d[i+2]);
    var l=(R+G+B)/3;
    d[i]  = clamp255(encode255(l+(R-l)*f));
    d[i+1]= clamp255(encode255(l+(G-l)*f));
    d[i+2]= clamp255(encode255(l+(B-l)*f));
  }
}
/* 25 · Display P3 — expansión de gamut vía matriz sRGB↔P3 */
var P3_M=[0.8225,0.1774,0.0001, 0.0332,0.9669,0.0, 0.0171,0.0724,0.9105];
var INV_P3_M=inv3(P3_M);
function applyDisplayP3(d, amt){
  if(amt===0) return;
  var f=1+0.25*amt;
  for(var i=0;i<d.length;i+=4){
    var r=d[i]/255, g=d[i+1]/255, b=d[i+2]/255;
    var pr=P3_M[0]*r + P3_M[1]*g + P3_M[2]*b;
    var pg=P3_M[3]*r + P3_M[4]*g + P3_M[5]*b;
    var pb=P3_M[6]*r + P3_M[7]*g + P3_M[8]*b;
    var L=lum709(pr,pg,pb);
    pr=L+(pr-L)*f; pg=L+(pg-L)*f; pb=L+(pb-L)*f;
    d[i]  = clamp255((INV_P3_M[0]*pr + INV_P3_M[1]*pg + INV_P3_M[2]*pb)*255);
    d[i+1]= clamp255((INV_P3_M[3]*pr + INV_P3_M[4]*pg + INV_P3_M[5]*pb)*255);
    d[i+2]= clamp255((INV_P3_M[6]*pr + INV_P3_M[7]*pg + INV_P3_M[8]*pb)*255);
  }
}
/* 26/27/28 · Filtros en CIE Lab: rotación a/b, croma DIN99, croma CAM16 */
function applyLabFilter(d, amt, mode){
  if(amt===0) return;
  var ang=15*amt*Math.PI/180, cs=Math.cos(ang), sn=Math.sin(ang);
  var scaleF=1+0.45*amt;
  for(var i=0;i<d.length;i+=4){
    var R=srgbLin(d[i]), G=srgbLin(d[i+1]), B=srgbLin(d[i+2]);
    var X=(0.4124564*R + 0.3575761*G + 0.1804375*B)*100;
    var Y=(0.2126729*R + 0.7151522*G + 0.0721750*B)*100;
    var Z=(0.0193339*R + 0.1191920*G + 0.9503041*B)*100;
    var fx=labF(X/XN), fy=labF(Y/YN), fz=labF(Z/ZN);
    var L=116*fy-16, a=500*(fx-fy), b=200*(fy-fz);
    if(mode==="rotate"){ var na=a*cs-b*sn; b=a*sn+b*cs; a=na; }
    else if(mode==="din99"){ a*=scaleF; b*=scaleF; }
    else { var cf=1+amt*(0.15+0.35*(1-L/100)); a*=cf; b*=cf; }
    var fy2=(L+16)/116, fx2=fy2+a/500, fz2=fy2-b/200;
    linearFromXyz(labFInv(fx2)*XN/100, labFInv(fy2)*YN/100, labFInv(fz2)*ZN/100, d, i);
  }
}
/* Conversiones HSV/HSL auxiliares (h en grados, s/l/v en 0-1) */
function rgbToHsv01(r,g,b,out){
  var mx=Math.max(r,g,b), mn=Math.min(r,g,b), dl=mx-mn, h=0;
  if(dl>1e-9){
    if(mx===r) h=60*(((g-b)/dl)%6); else if(mx===g) h=60*((b-r)/dl+2); else h=60*((r-g)/dl+4);
    if(h<0)h+=360;
  }
  out[0]=h; out[1]= mx>0 ? dl/mx : 0; out[2]=mx;
}
function hsvToRgb255(h,s,v){
  var c=v*s, x=c*(1-Math.abs((h/60)%2-1)), m=v-c, r=0,g=0,b=0;
  if(h<60){r=c;g=x;} else if(h<120){r=x;g=c;} else if(h<180){g=c;b=x;} else if(h<240){g=x;b=c;} else if(h<300){r=x;b=c;} else {r=c;b=x;}
  return [(r+m)*255,(g+m)*255,(b+m)*255];
}
/* 29 · HSL S-Curve — curva S sobre la lightness HSL */
function applyHslSCurve(d, amt){
  if(amt===0) return;
  var k=0.8*amt;
  for(var i=0;i<d.length;i+=4){
    var r=d[i]/255, g=d[i+1]/255, b=d[i+2]/255;
    var mx=Math.max(r,g,b), mn=Math.min(r,g,b), dl=mx-mn, L=(mx+mn)/2;
    var S= dl===0 ? 0 : dl/(1-Math.abs(2*L-1)||1), H=0;
    if(dl>1e-9){
      if(mx===r) H=60*(((g-b)/dl)%6); else if(mx===g) H=60*((b-r)/dl+2); else H=60*((r-g)/dl+4);
      if(H<0)H+=360;
    }
    var rgb=hslToRgb255(H, S*100, sCurve01(L,k)*100);
    d[i]=clamp255(rgb[0]); d[i+1]=clamp255(rgb[1]); d[i+2]=clamp255(rgb[2]);
  }
}
/* 30 · HSV Value Pop — estiramiento de valor (v-0.15)/0.75 */
function applyHsvValuePop(d, amt){
  if(amt===0) return;
  var hsv=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    rgbToHsv01(d[i]/255, d[i+1]/255, d[i+2]/255, hsv);
    var vFull=c01((hsv[2]-0.15)/0.75);
    var rgb=hsvToRgb255(hsv[0], hsv[1], hsv[2]+(vFull-hsv[2])*amt);
    d[i]=clamp255(rgb[0]); d[i+1]=clamp255(rgb[1]); d[i+2]=clamp255(rgb[2]);
  }
}
/* 31 · Selective Color — rojos atenuados, cianes realzados (Photoshop) */
function applySelectiveColor(d, amt){
  if(amt===0) return;
  var hsv=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    var r=d[i]/255, g=d[i+1]/255, b=d[i+2]/255;
    rgbToHsv01(r,g,b,hsv);
    var hue=hsv[0]/360;
    var dhR0=hue, dhR1=hue-1, dhC=hue-0.5;
    var redMask=Math.exp(-(dhR0*dhR0)/0.01)+Math.exp(-(dhR1*dhR1)/0.01);
    var cyanMask=Math.exp(-(dhC*dhC)/0.01);
    d[i]  = clamp255((r*(1-0.25*redMask*amt) + 0.1*cyanMask*g*amt)*255);
    d[i+1]= clamp255(g*(1+0.15*cyanMask*amt)*255);
  }
}
/* 32 · Color Grading — sombras teal, luces cálidas */
function applyColorGrading(d, amt){
  if(amt===0) return;
  for(var i=0;i<d.length;i+=4){
    var L=lum709(d[i]/255, d[i+1]/255, d[i+2]/255);
    var sh=c01((0.35-L)/0.35), hi=c01((L-0.65)/0.35);
    d[i]  = clamp255(d[i]   + (0.12*hi - 0.04*sh)*amt*255);
    d[i+1]= clamp255(d[i+1] + (0.04*hi)*amt*255);
    d[i+2]= clamp255(d[i+2] + (0.12*sh - 0.05*hi)*amt*255);
  }
}
/* 33 · Kelvin WB 4500K — cálido: R ×1.12, B ×0.88 a intensidad 1 */
function applyKelvin(d, amt){
  if(amt===0) return;
  var gr=1+0.12*amt, gb=1-0.12*amt;
  for(var i=0;i<d.length;i+=4){ d[i]=clamp255(d[i]*gr); d[i+2]=clamp255(d[i+2]*gb); }
}
/* Balance de blancos por temperatura (gen fijo «wbk»): ganancias RGB de la
   temperatura en Kelvin (aproximación de Tanner Helland), normalizadas
   para que 6500K sea neutro (ganancias 1, 1, 1). */
function kelvinRaw(K){
  var t=K/100, r, g, b;
  r= t<=66 ? 255 : 329.698727446*Math.pow(t-60, -0.1332047592);
  g= t<=66 ? 99.4708025861*Math.log(t)-161.1195681661 : 288.1221695283*Math.pow(t-60, -0.0755148492);
  b= t>=66 ? 255 : (t<=19 ? 0 : 138.5177312231*Math.log(t-10)-305.0447927307);
  return [ r<0?0:r>255?255:r, g<0?0:g>255?255:g, b<0?0:b>255?255:b ];
}
function kelvinGains(K){
  var a=kelvinRaw(K), n=kelvinRaw(6500);
  var g=[a[0]/n[0], a[1]/n[1], a[2]/n[2]];
  /* Reescalado con el verde fijo en 1: a 6500K sigue siendo identidad
     exacta, pero en los extremos el canal dominante sí supera 1 (el rojo
     a 2500K, el azul a 10000K) en vez de limitarse a recortar los demás. */
  return [g[0]/g[1], 1, g[2]/g[1]];
}
function applyWBTemp(d, K){
  if(K===6500) return;
  var g=kelvinGains(K);
  for(var i=0;i<d.length;i+=4){
    d[i]=clamp255(d[i]*g[0]); d[i+1]=clamp255(d[i+1]*g[1]); d[i+2]=clamp255(d[i+2]*g[2]);
  }
}
/* Tone mapping (gen fijo «tonemap»): el valor elige la curva, redondeado:
   0 Lineal (sin), 1 Reinhard, 2 ACES, 3 Filmic, 4 Curva S, 5 AgX. */
var TONEMAP_NAMES=["Lineal","Reinhard","ACES","Filmic","Curva S","AgX"];
/* Fuerza visual medida (media |Δ| por canal a intensidad 1, imagen de
   prueba foto-realista, 2026-11-24): Reinhard 10.6, ACES 31, Filmic 88,
   Curva S 8.4, AgX 56. Sin normalizar, a la misma intensidad Filmic y
   AgX se ven ~5-10× más fuertes que Reinhard/Curva S: cambiar a AgX
   parecía "aplicarse al 100%" mientras los otros parecían "al 0%".
   La ganancia comprime solo a los dos que se pasan, para que
   intensidad 1 signifique un cambio comparable en todos los
   operadores; los sutiles quedan como están (mezclar no puede
   amplificarlos). Se aplica igual en CPU, GPU y horneado. */
var TONEMAP_GAIN=[1, 1, 1, 0.35, 1, 0.55];
function applyToneMapGene(d, v){
  var m=Math.round(v);
  if(m<=0) return;
  if(m===1) applyReinhard(d,TONEMAP_GAIN[1]);
  else if(m===2) applyAces(d,TONEMAP_GAIN[2]);
  else if(m===3) applyFilmic(d,TONEMAP_GAIN[3]);
  else if(m===4) applySCurveRGB(d,TONEMAP_GAIN[4]);
  else applyAgx(d,TONEMAP_GAIN[5]);
}
/* Tone mapping como gen de 2 parametros: curva (0-5) + intensidad (0-1) */
function applyToneMap2(d, curve, amt){
  var m=Math.round(curve);
  if(m<=0 || amt===0) return;
  amt=amt*(TONEMAP_GAIN[m]||1); /* fuerza comparable entre operadores */
  if(amt===0) return;
  if(m===1) applyReinhard(d,amt);
  else if(m===2) applyAces(d,amt);
  else if(m===3) applyFilmic(d,amt);
  else if(m===4) applySCurveRGB(d,amt);
  else applyAgx(d,amt);
}
/* Saturacion como UN solo gen de 2 parametros: modelo + intensidad.
   Parametro 1 (modelo): 0 = OKLCh, 1 = HSLuv, 2 = CAM16-UCS.
   Parametro 2 (intensidad): factor de croma, 1 = neutro. */
var SAT_NAMES=["OKLCh","HSLuv","CAM16-UCS"];
function applySaturationModel(d, model, factor){
  if(factor===1 || factor===undefined) return;
  var m=Math.round(model);
  if(m===1) applyHsluv(d, factor);
  else if(m===2) applyCam16(d, factor);
  else applyOklch(d, factor);
}
/* Hue / color selectivo: rota el hue solo de los pixeles cercanos al hue
   objetivo (caida suave de 60 grados), girando en el plano a/b de OKLab.
   Parametro 1: hue objetivo (0-360). Parametro 2: desplazamiento (-180..180). */
function applySelectiveHue(d, targetHue, shift){
  if(shift===0) return;
  var lab=[0,0,0];
  for(var i=0;i<d.length;i+=4){
    var r=d[i]/255, g=d[i+1]/255, b=d[i+2]/255;
    var mx=Math.max(r,g,b), mn=Math.min(r,g,b), dl=mx-mn;
    if(dl<0.02) continue;
    var H=0;
    if(mx===r) H=60*(((g-b)/dl)%6); else if(mx===g) H=60*((b-r)/dl+2); else H=60*((r-g)/dl+4);
    if(H<0) H+=360;
    var diff=Math.abs(H-targetHue); if(diff>180) diff=360-diff;
    var wgt=smooth01((60-diff)/60);
    if(wgt<=0) continue;
    var ang=shift*wgt*Math.PI/180, cs=Math.cos(ang), sn=Math.sin(ang);
    srgbToOklab(d[i],d[i+1],d[i+2],lab);
    var a2=lab[1]*cs-lab[2]*sn, b2=lab[1]*sn+lab[2]*cs;
    oklabToSrgb(lab[0],a2,b2,d,i);
  }
}
/* Punto neutro de un gen de 2 parametros */
function isFixedNeutral(key, v1, v2, f){
  if(key==="tonemap") return Math.round(v1)<=0 || v2===0;
  if(key==="sat") return v2===1;
  if(key==="huesel") return v2===0;
  return v1===f.def;
}
/* Sub-genes de un filtro (key2..key6), en orden: cada uno viaja con su
   filtro, evoluciona, cruza y muta como un gen más. */
function subGenesOf(f){
  var subs=[];
  for(var n=2;n<=6;n++){
    var k=f["key"+n]; if(!k) break;
    subs.push({gkey:k, label:f["label"+n], min:f["min"+n], max:f["max"+n], def:f["def"+n]});
  }
  return subs;
}
/* Valores de un gen fijo multiparámetro, en orden [principal, sub2, ...],
   con los valores por defecto donde el genoma no define alguno. */
function geneParams(f, values){
  var arr=[values[f.key]];
  var subs=subGenesOf(f);
  for(var i=0;i<subs.length;i++){
    var v=values[subs[i].gkey];
    arr.push(v!==undefined? v : subs[i].def);
  }
  return arr;
}
/* ¿Está el gen fijo en su punto neutro (sin efecto)? arr = geneParams(...) */
function paramsNeutral(key, arr){
  if(key==="tonemap") return Math.round(arr[0])<=0 || arr[1]===0;
  if(key==="sat") return arr[1]===1;
  if(key==="huesel") return arr[1]===0;
  if(key==="curves") return arr[0]===0 && arr[1]===0 && arr[2]===1 && arr[3]===1 && arr[4]===0 && arr[5]===0;
  return false;
}
/* Contraste y curvas (paso 3): lift / gamma / gain estilo CDL por canal,
   después curva S, y al final sombras y luces por zonas de luminancia.
   p = [curvaS, lift, gamma, gain, sombras, luces]. La misma matemática
   vive en el shader GPU (PB.curves) y en el horneado (bakePointStep). */
function applyCurves(d, p){
  var s=p[0], lift=p[1], gamma=p[2], gain=p[3], shad=p[4], high=p[5];
  if(s===0 && lift===0 && gamma===1 && gain===1 && shad===0 && high===0) return;
  var invG=1/gamma;
  for(var i=0;i<d.length;i+=4){
    var t0=0, t1=0, t2=0;
    var x=d[i]/255;   var y=x*gain+lift; if(y<0)y=0; y=Math.pow(y,invG); t0=y + s*3*y*(1-y)*(y-0.5);
    x=d[i+1]/255; y=x*gain+lift; if(y<0)y=0; y=Math.pow(y,invG); t1=y + s*3*y*(1-y)*(y-0.5);
    x=d[i+2]/255; y=x*gain+lift; if(y<0)y=0; y=Math.pow(y,invG); t2=y + s*3*y*(1-y)*(y-0.5);
    var L=0.299*t0 + 0.587*t1 + 0.114*t2; if(L<0)L=0; if(L>1)L=1;
    var ws=Math.pow(1-L, 2.2), wh=smooth01((L-0.35)/0.65);
    var f=1 + shad*0.55*ws + high*0.55*wh, add=shad*ws*20/255;
    d[i]  = clamp255((t0*f+add)*255);
    d[i+1]= clamp255((t1*f+add)*255);
    d[i+2]= clamp255((t2*f+add)*255);
  }
}
/* 34 · Cross Process — curva S + verdes/amarillos fílmicos */
function applyCrossProcess(d, amt){
  if(amt===0) return;
  for(var i=0;i<d.length;i+=4){
    blendFull(d, i,
      c01(sCurve01(d[i]/255,0.6)*1.05),
      c01(sCurve01(d[i+1]/255,0.6)*1.08),
      c01(sCurve01(d[i+2]/255,0.6)*0.92), amt);
  }
}
/* 35 · Bleach Bypass — desaturación a 0.55 + curva S fuerte */
function applyBleachBypass(d, amt){
  if(amt===0) return;
  for(var i=0;i<d.length;i+=4){
    var r=d[i]/255, g=d[i+1]/255, b=d[i+2]/255, L=lum709(r,g,b);
    blendFull(d, i,
      sCurve01(L+(r-L)*0.55, 1.0),
      sCurve01(L+(g-L)*0.55, 1.0),
      sCurve01(L+(b-L)*0.55, 1.0), amt);
  }
}
/* 36 · Faded Matte — desat suave + negros levantados */
function applyFadedMatte(d, amt){
  if(amt===0) return;
  for(var i=0;i<d.length;i+=4){
    var r=d[i]/255, g=d[i+1]/255, b=d[i+2]/255, L=lum709(r,g,b);
    blendFull(d, i,
      c01((L+(r-L)*0.85)*0.92+0.08),
      c01((L+(g-L)*0.85)*0.92+0.08),
      c01((L+(b-L)*0.85)*0.92+0.08), amt);
  }
}

/* ==================================================================
   LUT 3D integrada — malla regular en el cubo RGB + interpolación trilineal.
   Cada LUT se genera dentro del espacio: se evalúa su función de color en
   los 33×33×33 vértices de la malla y el resto de colores se obtiene
   interpolando entre los 8 vértices de la celda donde cae el píxel.
   Sin archivos .cube y sin segunda imagen.
   ================================================================== */
var LUT_SIZE=33;
function lutC01(v){ return v<0?0 : v>1?1 : v; }
function lutSat(r,g,b,f){
  var l=0.299*r + 0.587*g + 0.114*b;
  return [l+(r-l)*f, l+(g-l)*f, l+(b-l)*f];
}
function lutCurve(x, amt){ return x + amt*3*x*(1-x)*(x-0.5); }
function lutAces(x){
  x=lutC01(x);
  var y=x*(2.51*x+0.03)/(x*(2.43*x+0.59)+0.14);
  return lutC01(y);
}
var LUT_DEFS=[]; /* Clon Top 75: no hay LUTs generadas por función; las 73 (incluidas las 7 base) llegan por el .bin en orden de ranking. */
var LUTS=[];
(function buildLuts(){
  var S=LUT_SIZE;
  LUT_DEFS.forEach(function(def){
    var data=new Float32Array(S*S*S*3), p=0;
    for(var bi=0; bi<S; bi++) for(var gi=0; gi<S; gi++) for(var ri=0; ri<S; ri++){
      var out=def.fn(ri/(S-1), gi/(S-1), bi/(S-1));
      data[p++]=lutC01(out[0]); data[p++]=lutC01(out[1]); data[p++]=lutC01(out[2]);
    }
    LUTS.push(data);
  });
})();

/* ==================================================================
   73 LUTs del Top 75 (.cube originales de 33×33×33) — precisión completa:
   cada valor viaja como float32 little-endian en assets/luts-part-XXX.bin,
   sin cuantizar a 8 bits en ningún punto. Orden de la malla: B exterior,
   G, R rápido; canales R,G,B — igual que las 8 integradas y que
   applyLut3D espera.
   ================================================================== */
var LUT_EXT_DEFS=[{"id": 80, "name": "Tanh"}, {"id": 14, "name": "Fibonacci"}, {"id": 101, "name": "Litografía"}, {"id": 150, "name": "Mutex"}, {"id": 110, "name": "Hill"}, {"id": 84, "name": "Grad. Descenso"}, {"id": 42, "name": "Fib Word"}, {"id": 72, "name": "Lorentz γ"}, {"id": 116, "name": "Enzima"}, {"id": 18, "name": "e Exponencial"}, {"id": 93, "name": "Moore 2^(t/2)"}, {"id": 53, "name": "Armónica"}, {"id": 118, "name": "Mitosis 2ⁿ"}, {"id": 122, "name": "PCR 2ⁿ"}, {"id": 62, "name": "Planck"}, {"id": 137, "name": "Doppler"}, {"id": 82, "name": "Atención"}, {"id": 142, "name": "Little L=λW"}, {"id": 134, "name": "Etapas"}, {"id": 22, "name": "Lucas"}, {"id": 86, "name": "BatchNorm"}, {"id": 97, "name": "EUV 13.5nm"}, {"id": 38, "name": "Primos Gap"}, {"id": 149, "name": "Semáforo"}, {"name": "Vibrante", "base": true}, {"id": 102, "name": "CMOS P=CV²f"}, {"id": 33, "name": "Riemann ζ"}, {"id": 96, "name": "FinFET"}, {"id": 131, "name": "Isp"}, {"id": 77, "name": "Sigmoide"}, {"id": 126, "name": "Kepler 3ª"}, {"id": 39, "name": "Tribonacci"}, {"id": 10, "name": "Sombra Hue 180°"}, {"id": 124, "name": "Evolución"}, {"id": 35, "name": "Bernoulli"}, {"id": 28, "name": "Log Discreto"}, {"id": 89, "name": "KL Divergencia"}, {"id": 54, "name": "Pitágoras 3-4-5"}, {"id": 135, "name": "Aerodinámica"}, {"id": 125, "name": "Tsiolkovsky Δv"}, {"id": 130, "name": "Empuje F=ṁ·ve"}, {"id": 153, "name": "Cache Hit"}, {"id": 16, "name": "Primos Mod"}, {"id": 120, "name": "Gibbs ΔG"}, {"id": 147, "name": "Paging 4KB"}, {"id": 123, "name": "Nernst"}, {"id": 121, "name": "Chargaff"}, {"id": 94, "name": "Dennard"}, {"id": 143, "name": "Round Robin"}, {"id": 87, "name": "Convolución"}, {"name": "Blanco y negro", "base": true}, {"id": 100, "name": "MOSFET"}, {"id": 34, "name": "Hilbert"}, {"id": 60, "name": "Espiral 3D"}, {"id": 78, "name": "ReLU"}, {"id": 74, "name": "Superposición"}, {"name": "Fría", "base": true}, {"id": 52, "name": "Galois GF(2⁸)"}, {"id": 43, "name": "Totient φ(n)"}, {"id": 19, "name": "Raíz de 2"}, {"id": 133, "name": "Reentrada"}, {"id": 27, "name": "Fib Hue"}, {"name": "Vintage", "base": true}, {"id": 59, "name": "Dim. Fractal"}, {"id": 95, "name": "RC Elmore"}, {"id": 24, "name": "Catalán"}, {"name": "Cine", "base": true}, {"name": "Cálida", "base": true}, {"name": "Pastel", "base": true}, {"id": 73, "name": "Túnel Cuántico"}, {"id": 138, "name": "Momento Angular"}, {"id": 23, "name": "Pell"}, {"id": 109, "name": "Michaelis-Menten"}];
/* Las 73 LUTs del Top 75 viajan en assets/luts-part-XXX.bin (float32 little-endian,
   mismo orden de malla: B exterior, G, R rápido; canales R,G,B) y se cargan
   en segundo plano con fetch: la primera población espera a que el .bin esté listo. */
var LUTS_READY=false, LUTS_FAILED=false, lutsReadyCbs=[];
function whenLutsReady(cb){ if(LUTS_READY||LUTS_FAILED) cb(); else lutsReadyCbs.push(cb); }
(function loadExtLuts(){
  function done(ok){
    LUTS_READY=ok; LUTS_FAILED=!ok;
    var cbs=lutsReadyCbs.splice(0);
    cbs.forEach(function(cb){ try{ cb(); }catch(e){} });
  }
  if(typeof fetch==="undefined"){ done(false); return; }
  /* El .bin va en 350 partes (assets/luts-part-XXX.bin) que se piden en paralelo
     y se ensamblan en orden: ninguna respuesta individual es grande. */
  var PARTS=350, partBufs=new Array(PARTS), partsDone=0, partFailed=false;
  function partLoaded(i, buf){
    if(partFailed) return;
    partBufs[i]=buf; partsDone++;
    if(partsDone<PARTS) return;
    var total=0; for(var j=0;j<PARTS;j++) total+=partBufs[j].byteLength;
    var joined=new Uint8Array(total), o=0;
    for(var k2=0;k2<PARTS;k2++){ joined.set(new Uint8Array(partBufs[k2]), o); o+=partBufs[k2].byteLength; }
    assemble(joined.buffer);
  }
  function assemble(buf){
    try{
      var per=LUT_SIZE*LUT_SIZE*LUT_SIZE*3;
      if(buf.byteLength<per*4*LUT_EXT_DEFS.length) throw new Error("bin incompleto");
      var all=new Float32Array(buf, 0, per*LUT_EXT_DEFS.length);
      for(var k=0;k<LUT_EXT_DEFS.length;k++) LUTS.push(all.subarray(k*per,(k+1)*per));
      done(true);
    }catch(e){ partError(); }
  }
  function partError(){ if(partFailed) return; partFailed=true; done(false); }
  for(var pi=0; pi<PARTS; pi++){
    (function(i){
      fetch("assets/luts-part-"+String(i).padStart(3,"0")+".bin").then(function(r){
        if(!r.ok) throw new Error("HTTP "+r.status);
        return r.arrayBuffer();
      }).then(function(b){ partLoaded(i, b); }).catch(partError);
    })(pi);
  }
})();

/* ==================================================================
   LUTs propias (.cube del usuario)
   - Se parsean de cualquier tamaño habitual (17³, 33³, 65³…) y se
     remuestrean a la malla interna 33³ con interpolación trilineal,
     así participan en la evolución y en la LUT horneada exactamente
     igual que las incluidas.
   - Se guardan en IndexedDB (datos 33³ ya remuestreados + nombre de
     archivo) y se vuelven a registrar al abrir la página.
   - El registro (añadirlas a LUTS / FILTERS / GENES / CANON) ocurre
     solo cuando las LUTs incluidas ya cargaron, para que sus índices
     queden siempre después de los de las incluidas y nunca colisionen.
   ================================================================== */
var CUSTOM_BY_IDX={}, customRecords=[], customLoaded=false, customRegistered=false, customReadyCbs=[];
function whenCustomLutsReady(cb){ if(customRegistered) cb(); else customReadyCbs.push(cb); }
function sampleLutSrc(data, S, r, g, b, out){
  var px=r*(S-1), py=g*(S-1), pz=b*(S-1);
  var x0,y0,z0,x1,y1,z1,fx,fy,fz;
  if(px<=0){ x0=0; x1=0; fx=0; } else if(px>=S-1){ x0=S-1; x1=S-1; fx=0; } else { x0=Math.floor(px); x1=x0+1; fx=px-x0; }
  if(py<=0){ y0=0; y1=0; fy=0; } else if(py>=S-1){ y0=S-1; y1=S-1; fy=0; } else { y0=Math.floor(py); y1=y0+1; fy=py-y0; }
  if(pz<=0){ z0=0; z1=0; fz=0; } else if(pz>=S-1){ z0=S-1; z1=S-1; fz=0; } else { z0=Math.floor(pz); z1=z0+1; fz=pz-z0; }
  var i000=((z0*S+y0)*S+x0)*3, i100=((z0*S+y0)*S+x1)*3;
  var i010=((z0*S+y1)*S+x0)*3, i110=((z0*S+y1)*S+x1)*3;
  var i001=((z1*S+y0)*S+x0)*3, i101=((z1*S+y0)*S+x1)*3;
  var i011=((z1*S+y1)*S+x0)*3, i111=((z1*S+y1)*S+x1)*3;
  for(var c=0;c<3;c++){
    var v00=data[i000+c] + fx*(data[i100+c]-data[i000+c]);
    var v10=data[i010+c] + fx*(data[i110+c]-data[i010+c]);
    var v01=data[i001+c] + fx*(data[i101+c]-data[i001+c]);
    var v11=data[i011+c] + fx*(data[i111+c]-data[i011+c]);
    var v0=v00 + fy*(v10-v00), v1=v01 + fy*(v11-v01);
    out[c]=v0 + fz*(v1-v0);
  }
}
function resampleLutTo33(data, S){
  if(S===LUT_SIZE) return data;
  var T=LUT_SIZE, out=new Float32Array(T*T*T*3), smp=[0,0,0], p=0;
  for(var bi=0; bi<T; bi++) for(var gi=0; gi<T; gi++) for(var ri=0; ri<T; ri++){
    sampleLutSrc(data, S, ri/(T-1), gi/(T-1), bi/(T-1), smp);
    out[p++]=lutC01(smp[0]); out[p++]=lutC01(smp[1]); out[p++]=lutC01(smp[2]);
  }
  return out;
}
function parseCubeText(text){
  var size=0, size1d=0, skipped1d=0, nums=[];
  var lines=String(text).split(/\r?\n/);
  for(var li=0; li<lines.length; li++){
    var t=lines[li].trim();
    if(!t || t.charAt(0)==="#") continue;
    var parts=t.split(/\s+/), kw=parts[0].toUpperCase();
    if(kw==="LUT_3D_SIZE"){ size=parseInt(parts[1],10); continue; }
    if(kw==="LUT_1D_SIZE"){ size1d=parseInt(parts[1],10); continue; }
    if(kw==="TITLE" || kw==="DOMAIN_MIN" || kw==="DOMAIN_MAX" ||
       kw==="LUT_3D_INPUT_RANGE" || kw==="LUT_1D_INPUT_RANGE" ||
       kw==="LUT_3D_OUTPUT_RANGE" || kw==="LUT_1D_OUTPUT_RANGE") continue;
    if(parts.length<3) continue;
    var r=parseFloat(parts[0]), g=parseFloat(parts[1]), b=parseFloat(parts[2]);
    if(isNaN(r) || isNaN(g) || isNaN(b)) continue;
    if(size1d>0 && size>0 && skipped1d<size1d){ skipped1d++; continue; }
    nums.push(r, g, b);
  }
  if(!size || size<2 || size>256) throw new Error("sin LUT_3D_SIZE válido");
  var need=size*size*size*3;
  if(nums.length<need) throw new Error("datos incompletos");
  var data=new Float32Array(need);
  for(var i=0;i<need;i++) data[i]=lutC01(nums[i]);
  return { size:size, data:resampleLutTo33(data, size) };
}
/* ---------- IndexedDB de LUTs propias ---------- */
var IDB_DB="genetic-color-grading-top-75", IDB_STORE="custom-luts";
function idbOpen(cb){
  try{
    if(typeof indexedDB==="undefined"){ cb(null); return; }
    var req=indexedDB.open(IDB_DB, 3);
    req.onupgradeneeded=function(){ var db=req.result; try{ if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, {keyPath:"id"}); }catch(e){} try{ if(!db.objectStoreNames.contains("lut65")) db.createObjectStore("lut65", {keyPath:"id"}); }catch(e){} try{ if(!db.objectStoreNames.contains("compass")) db.createObjectStore("compass", {keyPath:"id"}); }catch(e){} };
    req.onsuccess=function(){ cb(req.result); };
    req.onerror=function(){ cb(null); };
  }catch(e){ cb(null); }
}
function idbGetAll(cb){
  idbOpen(function(db){
    if(!db){ cb([]); return; }
    try{
      var out=[], tx=db.transaction(IDB_STORE, "readonly"), st=tx.objectStore(IDB_STORE);
      var rq=st.getAll();
      rq.onsuccess=function(){ cb(rq.result||[]); };
      rq.onerror=function(){ cb([]); };
    }catch(e){ cb([]); }
  });
}
function idbPut(rec){
  idbOpen(function(db){
    if(!db) return;
    try{
      var tx=db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put({ id:rec.idbId, name:rec.name, origSize:rec.origSize||LUT_SIZE, addedAt:rec.addedAt||0, data:rec.data.buffer });
    }catch(e){}
  });
}
function idbDelete(id){
  if(!id) return;
  idbOpen(function(db){
    if(!db) return;
    try{
      var tx=db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(id);
    }catch(e){}
  });
}
function sanitizeLutName(name){
  /* El nombre viene del archivo del usuario y acaba en etiquetas que se
     componen con innerHTML (receta de transformaciones): se le quitan
     los caracteres que podrían romper el marcado o inyectar HTML. */
  var s=String(name||"LUT").replace(/[<>&"']/g, "").replace(/[\u0000-\u001f]/g, " ").trim();
  if(s.length>120) s=s.slice(0,120);
  return s || "LUT propia";
}
function registerCustomRecord(rec){
  rec.name=sanitizeLutName(rec.name);
  var idx=LUTS.length;
  LUTS.push(rec.data);
  CUSTOM_BY_IDX[idx]={ idbId:rec.idbId, name:rec.name, removed:false };
  var key="lut"+idx;
  var f={ key:key, label:"LUT 3D · "+rec.name.replace(/\.cube$/i,""), small:"LUT propia · malla 33³ · trilineal", min:0, max:1, def:0 };
  FILTERS.push(f); FBY[key]=f; CANON.push(key);
  GENES.push({ gkey:key, fkey:key, label:f.label, small:f.small, min:0, max:1, def:0, cls:"", sub:false });
  if(typeof ancestorValues!=="undefined") ancestorValues[key]=0;
  rec.idx=idx; rec.key=key;
  return idx;
}
function tryRegisterCustoms(){
  if(!customLoaded || customRegistered) return;
  if(!LUTS_READY && !LUTS_FAILED) return;
  customRegistered=true;
  customRecords.forEach(function(rec){ try{ registerCustomRecord(rec); }catch(e){} });
  var cbs=customReadyCbs.splice(0);
  cbs.forEach(function(cb){ try{ cb(); }catch(e){} });
}
(function loadCustomLuts(){
  var finished=false;
  function done(recs){
    if(finished) return; finished=true;
    customRecords=recs||[]; customLoaded=true; tryRegisterCustoms();
  }
  setTimeout(function(){ done(customRecords); }, 3000); /* si IndexedDB se cuelga, la fase de genes no se bloquea */
  try{
    idbGetAll(function(recs){
      var out=[];
      (recs||[]).slice().sort(function(a,b){ return (a.addedAt||0)-(b.addedAt||0); }).forEach(function(r){
        try{
          if(!r || !r.name || !r.data) return;
          var buf = (r.data instanceof ArrayBuffer) ? r.data : (r.data.buffer || null);
          if(!buf || buf.byteLength<LUT_SIZE*LUT_SIZE*LUT_SIZE*3*4) return;
          out.push({ idbId:r.id, name:sanitizeLutName(r.name), origSize:r.origSize||LUT_SIZE, addedAt:r.addedAt||0, data:new Float32Array(buf, 0, LUT_SIZE*LUT_SIZE*LUT_SIZE*3) });
        }catch(e){}
      });
      done(out);
    });
  }catch(e){ done([]); }
})();
whenLutsReady(function(){ tryRegisterCustoms(); });

/* ==================================================================
   LUTs 65³ bajo demanda
   - La fase «Elige tus genes» sigue trabajando SOLO con las rejillas
     33³ ya cargadas: aquí no se genera ningún 65³ mientras genePhase
     esté activa (ensureLut65 se niega y getRenderLut devuelve 33³).
   - Cuando una LUT elegida se usa por primera vez fuera de esa fase
     (rejilla, Evolucionar, vistas previas, horneado), su rejilla 65³
     se genera en un Web Worker por upsampling tricúbico Catmull-Rom
     separable desde su rejilla 33³: índices pares = copia exacta;
     impares (puntos medios) con pesos (-1, 9, 9, -1)/16; en los bordes
     los vecinos fuera de rango se EXTRAPOLAN linealmente
     (fantasma = 2·borde − siguiente), nunca se sujetan. Pases en R,
     luego G, luego B. Salida Float32Array de 65³ nodos, mismo layout
     que el 33³ (B exterior / G / R rápido, canales R,G,B).
   - Caché: Map en memoria por id + persistencia en IndexedDB
     (store «lut65») para no recomputar en visitas posteriores.
     Mientras se genera se muestra el indicador «65³…», sin bloquear.
   ================================================================== */
var LUT65_SIZE=65, LUT65_NODES=274625;
var lut65Cache=new Map(), lut65Pending=new Map();
var lut65Worker=null, lut65WorkerSeq=0, lut65Jobs={}, lut65Active=0;
function lut65StatusShow(delta){
  lut65Active=Math.max(0, lut65Active+delta);
  var el=document.getElementById("lut65Status");
  if(el) el.hidden= lut65Active<=0;
}
function upsample33to65(src){
  var S=33, T=65;
  function valAt(line, k){ if(k<0) return 2*line[0]-line[1]; if(k>=S) return 2*line[S-1]-line[S-2]; return line[k]; }
  function upLine(line){
    var out=new Float32Array(T), j;
    for(var i=0;i<S;i++) out[2*i]=line[i];
    for(j=0;j<S-1;j++) out[2*j+1]=(-valAt(line,j-1)+9*line[j]+9*line[j+1]-valAt(line,j+2))/16;
    return out;
  }
  var line=new Float32Array(S), b, g, r, c, up;
  /* Pase R: (B33,G33,R33) → (B33,G33,R65) */
  var tmp1=new Float32Array(S*S*T*3);
  for(b=0;b<S;b++) for(g=0;g<S;g++) for(c=0;c<3;c++){
    for(r=0;r<S;r++) line[r]=src[((b*S+g)*S+r)*3+c];
    up=upLine(line);
    for(r=0;r<T;r++) tmp1[((b*S+g)*T+r)*3+c]=up[r];
  }
  /* Pase G: (B33,G33,R65) → (B33,G65,R65) */
  var tmp2=new Float32Array(S*T*T*3);
  for(b=0;b<S;b++) for(r=0;r<T;r++) for(c=0;c<3;c++){
    for(g=0;g<S;g++) line[g]=tmp1[((b*S+g)*T+r)*3+c];
    up=upLine(line);
    for(g=0;g<T;g++) tmp2[((b*T+g)*T+r)*3+c]=up[g];
  }
  /* Pase B: (B33,G65,R65) → (B65,G65,R65) */
  var out=new Float32Array(T*T*T*3);
  for(g=0;g<T;g++) for(r=0;r<T;r++) for(c=0;c<3;c++){
    for(b=0;b<S;b++) line[b]=tmp2[((b*T+g)*T+r)*3+c];
    up=upLine(line);
    for(b=0;b<T;b++) out[((b*T+g)*T+r)*3+c]=up[b];
  }
  return out;
}
function lut65KeyFor(id){
  var cu=(typeof CUSTOM_BY_IDX!=="undefined") ? CUSTOM_BY_IDX[id] : null;
  return (cu && cu.idbId) ? ("custom:"+cu.idbId) : ("lut:"+id);
}
function idb65Get(key, cb){
  idbOpen(function(db){
    if(!db || !db.objectStoreNames.contains("lut65")){ cb(null); return; }
    try{
      var rq=db.transaction("lut65","readonly").objectStore("lut65").get(key);
      rq.onsuccess=function(){
        var rec=rq.result;
        if(!rec || !rec.data){ cb(null); return; }
        var buf=(rec.data instanceof ArrayBuffer) ? rec.data : (rec.data.buffer||null);
        cb(buf);
      };
      rq.onerror=function(){ cb(null); };
    }catch(e){ cb(null); }
  });
}
function idb65Put(key, arr){
  if(!arr) return;
  idbOpen(function(db){
    if(!db || !db.objectStoreNames.contains("lut65")) return;
    try{ db.transaction("lut65","readwrite").objectStore("lut65").put({ id:key, data:arr.buffer }); }catch(e){}
  });
}
function getRenderLut(id){
  if(typeof genePhase!=="undefined" && genePhase) return { data:LUTS[id], S:LUT_SIZE };
  var d=lut65Cache.get(id);
  if(d) return { data:d, S:LUT65_SIZE };
  return { data:LUTS[id], S:LUT_SIZE };
}
function hasLut65(id){ return lut65Cache.has(id); }
function finishLut65(id, arr){
  if(arr && arr.length===LUT65_NODES*3){
    lut65Cache.set(id, arr);
    idb65Put(lut65KeyFor(id), arr);
    if(typeof GPU!=="undefined" && GPU && GPU.invalidateLut) GPU.invalidateLut(id);
  }
  var cbs=lut65Pending.get(id)||[];
  lut65Pending.delete(id);
  lut65StatusShow(-1);
  cbs.forEach(function(cb){ try{ cb(arr||null); }catch(e){} });
}
function runUpsampleWorker(id){
  var src=LUTS[id];
  if(!src){ finishLut65(id, null); return; }
  try{
    if(!lut65Worker){
      var wsrc="self.onmessage=function(e){ var m=e.data; var fn="+upsample33to65.toString()+"; var out=fn(new Float32Array(m.buf)); self.postMessage({ id:m.id, buf:out.buffer }, [out.buffer]); };";
      lut65Worker=new Worker(URL.createObjectURL(new Blob([wsrc], {type:"text/javascript"})));
      lut65Worker.onmessage=function(e){
        var job=lut65Jobs[e.data.id]; if(!job) return;
        delete lut65Jobs[e.data.id];
        finishLut65(job.lutId, new Float32Array(e.data.buf));
      };
      lut65Worker.onerror=function(){
        var jobs=lut65Jobs; lut65Jobs={};
        try{ lut65Worker.terminate(); }catch(e){}
        lut65Worker=null;
        Object.keys(jobs).forEach(function(k){
          var j=jobs[k];
          setTimeout(function(){ try{ finishLut65(j.lutId, upsample33to65(LUTS[j.lutId])); }catch(e2){ finishLut65(j.lutId, null); } }, 0);
        });
      };
    }
    var seq=++lut65WorkerSeq;
    lut65Jobs[seq]={ lutId:id };
    var copy=src.slice(); /* copia transferible: LUTS[ext] es una vista sobre el buffer grande */
    lut65Worker.postMessage({ id:seq, buf:copy.buffer }, [copy.buffer]);
  }catch(e){
    setTimeout(function(){ try{ finishLut65(id, upsample33to65(LUTS[id])); }catch(e2){ finishLut65(id, null); } }, 0);
  }
}
function ensureLut65(id, cb){
  cb=cb||function(){};
  if(typeof genePhase!=="undefined" && genePhase){ cb(null); return; } /* la fase de genes nunca genera 65³ */
  if(!LUTS[id]){ cb(null); return; }
  if(lut65Cache.has(id)){ cb(lut65Cache.get(id)); return; }
  if(lut65Pending.has(id)){ lut65Pending.get(id).push(cb); return; }
  lut65Pending.set(id, [cb]);
  lut65StatusShow(1);
  idb65Get(lut65KeyFor(id), function(buf){
    if(buf && buf.byteLength>=LUT65_NODES*3*4){
      finishLut65(id, new Float32Array(buf, 0, LUT65_NODES*3));
      return;
    }
    runUpsampleWorker(id);
  });
}
function ensureLuts65(ids, done){
  var uniq=[];
  (ids||[]).forEach(function(id){ id=+id; if(id>=0 && LUTS[id] && uniq.indexOf(id)<0) uniq.push(id); });
  if(!uniq.length){ if(done) done(); return; }
  var left=uniq.length;
  uniq.forEach(function(id){ ensureLut65(id, function(){ if(--left<=0 && done) done(); }); });
}
function ensure65ForGenome(g, done){
  var ids=[];
  try{ activeLutsOf(g).forEach(function(a){ ids.push(a.id); }); }catch(e){}
  ensureLuts65(ids, done);
}
function ensure65ForGenomes(list, done){
  var ids=[];
  (list||[]).forEach(function(g){
    try{ activeLutsOf(g).forEach(function(a){ if(ids.indexOf(a.id)<0) ids.push(a.id); }); }catch(e){}
  });
  ensureLuts65(ids, done);
}

/* Ejes precalculados para la interpolación trilineal: para cada valor de
   canal 0-255, los nodos de la malla 33³ que lo rodean y la fracción entre
   ellos. Exactamente los mismos números que calcular x/255*32 por píxel. */
var LUT_AX0=new Int32Array(256), LUT_AX1=new Int32Array(256), LUT_AXF=new Float32Array(256);
for(var av=0; av<256; av++){
  var ap=av/255*(LUT_SIZE-1), a0=Math.floor(ap);
  if(a0>=LUT_SIZE-1){ a0=LUT_SIZE-1; LUT_AXF[av]=0; } else { LUT_AXF[av]=ap-a0; }
  LUT_AX0[av]=a0; LUT_AX1[av]= a0<LUT_SIZE-1 ? a0+1 : a0;
}
function applyLut3D(d, amount, lutId){
  if(amount===0) return;
  var id=Math.round(lutId);
  if(id<0) id=0; if(id>=LUTS.length) id=LUTS.length-1;
  var rl=getRenderLut(id); var data=rl.data; if(!data) return;
  var S=rl.S, inv=1-amount, S1=S-1;
  for(var i=0;i<d.length;i+=4){
    var oR=d[i], oG=d[i+1], oB=d[i+2];
    /* Ejes desde el valor flotante (misma fórmula que precalculan
       LUT_AX0/LUT_AX1/LUT_AXF para los enteros 0-255, sin cuantizar) */
    var ap=oR/255*S1, x0, x1, fx;
    if(ap>=S1){ x0=S1; x1=S1; fx=0; } else if(ap<=0){ x0=0; x1=1; fx=0; } else { x0=Math.floor(ap); x1=x0+1; fx=ap-x0; }
    var aq=oG/255*S1, y0, y1, fy;
    if(aq>=S1){ y0=S1; y1=S1; fy=0; } else if(aq<=0){ y0=0; y1=1; fy=0; } else { y0=Math.floor(aq); y1=y0+1; fy=aq-y0; }
    var ar=oB/255*S1, z0, z1, fz;
    if(ar>=S1){ z0=S1; z1=S1; fz=0; } else if(ar<=0){ z0=0; z1=1; fz=0; } else { z0=Math.floor(ar); z1=z0+1; fz=ar-z0; }
    var i000=((z0*S+y0)*S+x0)*3, i100=((z0*S+y0)*S+x1)*3;
    var i010=((z0*S+y1)*S+x0)*3, i110=((z0*S+y1)*S+x1)*3;
    var i001=((z1*S+y0)*S+x0)*3, i101=((z1*S+y0)*S+x1)*3;
    var i011=((z1*S+y1)*S+x0)*3, i111=((z1*S+y1)*S+x1)*3;
    for(var c=0;c<3;c++){
      var v00=data[i000+c] + fx*(data[i100+c]-data[i000+c]);
      var v10=data[i010+c] + fx*(data[i110+c]-data[i010+c]);
      var v01=data[i001+c] + fx*(data[i101+c]-data[i001+c]);
      var v11=data[i011+c] + fx*(data[i111+c]-data[i011+c]);
      var v0=v00 + fy*(v10-v00), v1=v01 + fy*(v11-v01);
      var v=(v0 + fz*(v1-v0))*255;
      var orig= c===0?oR : c===1?oG : oB;
      d[i+c]=clamp255(orig*inv + v*amount);
    }
  }
}

/* ==================================================================
   Algoritmo genético
   Genoma = { values: {lut: intensidad}, order: [LUTs en orden] }
   ================================================================== */
var FILTERS=[
  /* Genes fijos: pasos 1-11 al inicio, antes de las LUTs (paso 12).
     Exposición, balance de blancos, curvas, tone mapping, saturación y
     hue son puntuales y se hornean en un único .cube; Dehaze, Retinex,
     Clarity, Laplaciano local y Guided Detail son ESPACIALES (usan el
     vecindario del píxel) y NO caben en un .cube: la imagen exportada
     sí los lleva, la LUT horneada no (ver spatialGenesActive). */
  {key:"exp",     label:"Exposición",        small:"Paso 1 · EV · siempre presente",            min:-2,   max:2,     def:0,    fixed:1},
  {key:"wbk",     label:"Balance de blancos", small:"Paso 2 · Kelvin · siempre presente",        min:2500, max:10000, def:6500, fixed:1},
  {key:"dehaze",  label:"Dehaze",            small:"Paso 3 · velo atmosférico · siempre presente", min:0, max:1, def:0, fixed:1},
  {key:"retinex", label:"Retinex",           small:"Paso 4 · iluminación / reflectancia · siempre presente", min:0, max:1, def:0, fixed:1},
  {key:"curves",  label:"Contraste y curvas", small:"Paso 5 · lift / gamma / gain + curva S · siempre presente", min:-1, max:1, def:0, fixed:1, label1:"Curva S", key2:"curvesLift", label2:"Lift", min2:-0.3, max2:0.3, def2:0, key3:"curvesGamma", label3:"Gamma", min3:0.5, max3:2, def3:1, key4:"curvesGain", label4:"Gain", min4:0.5, max4:1.6, def4:1, key5:"curvesShad", label5:"Sombras", min5:-1, max5:1, def5:0, key6:"curvesHigh", label6:"Luces", min6:-1, max6:1, def6:0},
  {key:"clarity", label:"Clarity",           small:"Paso 6 · contraste local de medios tonos · siempre presente", min:0, max:1, def:0, fixed:1},
  {key:"tonemap", label:"Tone mapping",       small:"Paso 7 · curva + intensidad · siempre presente", min:0, max:5, def:0, fixed:1, label1:"Curva / operador", key2:"tonemapAmt", label2:"Intensidad", min2:0, max2:1, def2:1},
  {key:"loclap",  label:"Laplaciano local",  small:"Paso 8 · detalle local multi-escala · siempre presente", min:0, max:1, def:0, fixed:1},
  {key:"guided",  label:"Guided Detail",     small:"Paso 9 · detalle por filtro guiado · siempre presente", min:0, max:1, def:0, fixed:1},
  {key:"sat",     label:"Saturación",         small:"Paso 10 · modelo + intensidad · siempre presente", min:0, max:2, def:0, fixed:1, label1:"Modelo", key2:"satAmt", label2:"Intensidad", min2:0, max2:2, def2:1},
  {key:"huesel",  label:"Hue / Color selectivo", small:"Paso 11 · hue objetivo + desplazamiento · siempre presente", min:0, max:360, def:0, fixed:1, label1:"Hue objetivo", key2:"hueselShift", label2:"Desplazamiento", min2:-180, max2:180, def2:0},
];
/* Las 73 LUTs del Top 75 se registran como filtros independientes (gen 0-1 cada una), en orden de ranking */
LUT_EXT_DEFS.forEach(function(def, i){
  FILTERS.push({key:"lut"+i, label:"LUT 3D · "+def.name, small:(def.base? "LUT base · malla 33³ · trilineal" : "LUT aprobada "+def.id+" · malla 33³ · trilineal"), min:0, max:1, def:0});
});
var FBY={}; FILTERS.forEach(function(f){ FBY[f.key]=f; });
var CANON=FILTERS.map(function(f){ return f.key; });
/* Genes fijos: pasos 1-11 siempre al inicio, en orden. */
var FIXED_HEAD=["exp","wbk","dehaze","retinex","curves","clarity","tonemap","loclap","guided","sat","huesel"];
var FIXED_KEYS=FIXED_HEAD.slice();
function fixOrder(order){
  var rest=[];
  for(var i=0;i<order.length;i++){ if(FIXED_KEYS.indexOf(order[i])<0) rest.push(order[i]); }
  return FIXED_HEAD.concat(rest);
}
/* Genes: un filtro puede tener sub-genes (key2..key6) que viajan con él */
var GENES=[];
FILTERS.forEach(function(f){
  GENES.push({gkey:f.key, fkey:f.key, label:f.label, small:f.small, min:f.min, max:f.max, def:f.def, cls:f.cls, sub:false});
  subGenesOf(f).forEach(function(sg){
    GENES.push({gkey:sg.gkey, fkey:f.key, label:sg.label, small:f.label, min:sg.min, max:sg.max, def:sg.def, cls:"", sub:true});
  });
});
/* Tamaño de la rejilla: lado N (3, 5, 7 o 9). La rejilla es N×N, con el
   original siempre en la celda central y POP_SIZE = N²−1 variantes. */
var GRID_SIZES=[3,5,7,9];
/* Tamaño por defecto: 3×3 en celular y en PC (8 variantes + original
   al centro), a petición de Bryan 2026-11-24. El slider de la rejilla
   sigue permitiendo cambiarlo a mano en cualquier momento. */
var GRID_SIZE=3;
var POP_SIZE=GRID_SIZE*GRID_SIZE-1, CENTER_CELL=(GRID_SIZE*GRID_SIZE-1)/2;
function applyGridSize(n){ GRID_SIZE=n; POP_SIZE=n*n-1; CENTER_CELL=(n*n-1)/2; }

function applyOp(imgData, key, v){
  var d=imgData.data, w=imgData.width, h=imgData.height;
  if(key.slice(0,3)==="lut"){ applyLut3D(d, v, parseInt(key.slice(3),10)); return; }
  switch(key){
    case "lin": applyLinearSat(d,v); break;
    case "cielch": applyCielch(d,v); break;
    case "oklch": applyOklch(d,v); break;
    case "vib": applyVibrance(d,v); break;
    case "con": applyContrastTemp(d,v,0); break;
    case "temp": applyContrastTemp(d,0,v); break;
    case "hct": applyHct(d,v); break;
    case "jz": applyJz(d,v); break;
    case "hsluv": applyHsluv(d,v); break;
    case "ipt": applyIpt(d,v); break;
    case "agx": applyAgx(d,v); break;
    case "dehaze": applyDehaze(d,w,h,v); break;
    case "clarity": applyClarity(d,w,h,v); break;
    case "exp": applyExposure(d,v); break;
    case "wbk": applyWBTemp(d,v); break;
    case "curves": applyCurves(d, v); break;
    case "tonemap": if(Array.isArray(v)) applyToneMap2(d,v[0],v[1]); else applyToneMapGene(d,v); break;
    case "sat": applySaturationModel(d, v[0], v[1]); break;
    case "huesel": applySelectiveHue(d, v[0], v[1]); break;
    case "high": applyToneZone(d,v,"high"); break;
    case "shad": applyToneZone(d,v,"shad"); break;
    case "whites": applyToneZone(d,v,"white"); break;
    case "blacks": applyToneZone(d,v,"black"); break;
    case "gamma": applyGamma(d,v); break;
    case "tintgm": applyTintGM(d,v); break;
    case "huerot": applyHueRotHSL(d,v); break;
    case "split": applySplitTone(d,v[0],v[1]); break;
    case "duotone": applyDuotone(d,v[0],v[1]); break;
    case "cam16": applyCam16(d,v); break;
    case "ciecam02": applyCiecam02(d,v); break;
    case "ictcp": applyIctcp(d,v); break;
    case "jzazbz": applyJz(d,v); break;
    case "huerotok": applyHueRotOK(d,v); break;
    case "lchclarity": applyLchClarity(d,v); break;
    case "bradford": applyBradford(d,v); break;
    case "satlum": applySatLum(d,v); break;
    case "aces": applyAces(d,v); break;
    case "filmic": applyFilmic(d,v); break;
    case "reinhard": applyReinhard(d,v); break;
    case "grain": applyGrain(d,v); break;
    case "vignette": applyVignette(d,w,h,v); break;
    case "ca": applyCA(d,w,h,v); break;
    case "awb": applyAWB(d,v); break;
    case "freqsep": applyFreqSep(d,w,h,v); break;
    case "micro": applyMicro(d,w,h,v); break;
    case "filmsim": applyFilmSim(d,v[0],v[1]); break;
    case "hdrpq": applyHdrPq(d,v); break;
    case "dither": applyDither(d,w,h,v); break;
    case "seldesat": applySelDesat(d,v[0],v[1]); break;
    case "retinex": applyRetinex(d,w,h,v); break;
    case "loclap": applyLocalLaplacian(d,w,h,v); break;
    case "guided": applyGuidedDetail(d,w,h,v); break;
    case "autolevels": applyAutoLevels(d,v); break;
    case "scurve": applySCurveRGB(d,v); break;
    case "kodak2383": applyKodak2383(d,v); break;
    case "mantiuk": applyMantiuk(d,v); break;
    case "drago": applyDrago(d,v); break;
    case "whitepatch": applyWBGains(d,v,"white"); break;
    case "grayworld": applyWBGains(d,v,"gray"); break;
    case "shadesgray": applyWBGains(d,v,"shades"); break;
    case "vonkries": applyVonKries(d,v); break;
    case "ycbcr": applyYCbCrChroma(d,v); break;
    case "prophoto": applyProPhoto(d,v); break;
    case "displayp3": applyDisplayP3(d,v); break;
    case "labrotate": applyLabFilter(d,v,"rotate"); break;
    case "din99": applyLabFilter(d,v,"din99"); break;
    case "cam16jmh": applyLabFilter(d,v,"cam16"); break;
    case "hslscurve": applyHslSCurve(d,v); break;
    case "hsvpop": applyHsvValuePop(d,v); break;
    case "selcolor": applySelectiveColor(d,v); break;
    case "grading": applyColorGrading(d,v); break;
    case "kelvin": applyKelvin(d,v); break;
    case "crossproc": applyCrossProcess(d,v); break;
    case "bleach": applyBleachBypass(d,v); break;
    case "faded": applyFadedMatte(d,v); break;
    case "lut0": applyLut3D(d,v,0); break;
    case "lut1": applyLut3D(d,v,1); break;
    case "lut2": applyLut3D(d,v,2); break;
    case "lut3": applyLut3D(d,v,3); break;
    case "lut4": applyLut3D(d,v,4); break;
    case "lut5": applyLut3D(d,v,5); break;
    case "lut6": applyLut3D(d,v,6); break;
    case "lut7": applyLut3D(d,v,7); break;
  }
}
function processGenomeFd(imgData, genome){
  /* Cadena en flotante de extremo a extremo SIN cuantizar: los píxeles
     viven en un Float32Array (escala 0..255, codificación sRGB) entre
     filtros y ese array es lo que se devuelve. Es la fuente tanto de la
     cuantización a 8 bits de processGenome como de la salida HDR de
     16 bits (PNG PQ): ninguna de las dos vuelve a pasar por un
     paso intermedio de 8 bits. No muta imgData. */
  var src=imgData.data, n=src.length, q;
  var fd=new Float32Array(n);
  for(q=0;q<n;q++) fd[q]=src[q];
  var view={data:fd, width:imgData.width, height:imgData.height};
  for(var i=0;i<genome.order.length;i++){
    var key=genome.order[i], f=FBY[key];
    if(!f) continue;
    if(f.key2){
      if(genome.values[key]===undefined) continue;
      var arr=geneParams(f, genome.values);
      if(paramsNeutral(key, arr)) continue; /* los sub-genes solo importan si el filtro está activo */
      applyOp(view, key, arr);
    }else{
      var v=genome.values[key];
      if(v===f.def || v===undefined) continue;
      applyOp(view, key, v);
    }
  }
  return fd;
}
function processGenome(imgData, genome, dith){
  /* La cadena float32 de processGenomeFd y, solo al final, la única
     cuantización a enteros 0..255 al escribir en imgData.
     dith (opcional): descriptor del combobox — {kind:"ordered", n, m}
     suma el umbral normalizado (m−0.5) según (x%n, y%n) antes de
     redondear; {kind:"fs"} difunde el error (Floyd-Steinberg);
     {kind:"hybrid"} hace blue noise 512 + Floyd-Steinberg en Oklch.
     null = redondeo normal. El canal alfa no se toca. */
  var src=imgData.data, n=src.length, q;
  var fd=processGenomeFd(imgData, genome);
  if(dith && dith.kind==="ordered"){
    /* Única cuantización, con dithering ordenado: a cada píxel se le
       suma (m−0.5) según (x%n, y%n) y el Uint8ClampedArray destino
       redondea a 0..255. El canal alfa no se toca. */
    var dw=imgData.width, dh=imgData.height, dn=dith.n, dm=dith.m;
    for(var py=0;py<dh;py++){
      var prow=py*dw*4, pmrow=(py%dn)*dn;
      for(var px=0;px<dw;px++){
        var po=prow+px*4, pt=dm[pmrow+(px%dn)]-0.5;
        src[po]=fd[po]+pt; src[po+1]=fd[po+1]+pt; src[po+2]=fd[po+2]+pt; src[po+3]=fd[po+3];
      }
    }
  }else if(dith && dith.kind==="fs"){
    floydSteinbergQuantize(fd, imgData.width, imgData.height, src);
  }else if(dith && dith.kind==="hybrid"){
    hybridQuantize(fd, imgData.width, imgData.height, src, dith.bn);
  }else{
    for(q=0;q<n;q++) src[q]=fd[q]; /* única cuantización: al volcar en el Uint8ClampedArray destino */
  }
  return imgData;
}

/* ==================================================================
   Fallback de CPU en paralelo (solo en este clon)
   Cuando la GPU no está disponible, las miniaturas de la rejilla
   se reparten entre un pool de Web Workers: un worker por vista
   previa, con un pool del tamaño de navigator.hardwareConcurrency.
   Cada worker procesa su genoma de forma independiente sobre su
   copia de los píxeles y solo recibe las LUT 3D que ese genoma usa
   de verdad; el hilo principal solo compone los resultados en los
   canvas. El código del worker se genera con
   Function.prototype.toString() de las funciones reales del motor
   de arriba, así que procesa exactamente igual que processGenome.
   Si los workers no existen, no arrancan o fallan, se degrada con
   gracia al CPU de un solo hilo de siempre (ver renderPopulation).
   ================================================================== */
var CPU_ENGINE_FNS=[ encode255, srgbLin255, clamp255, applyLinearSat, labF, labFInv, applyCielch, srgbToOklab, oklabToSrgb, applyOklch, isSkin, applyVibrance, applyContrastTemp, inv3, xyzFromLinear, linearFromXyz, camResp, camRespInv, applyHct, pqEnc, pqDec, applyJz, applyHsluv, iptPow, iptPowInv, applyIpt, agxCurve, applyAgx, boxBlur, blur2, lumArray, applyDehaze, applyClarity, hslToRgb255, applyExposure, smooth01, applyToneZone, applyGamma, applyTintGM, applyHueRotHSL, applyHueRotOK, applySplitTone, applyDuotone, applyCam16, applyCiecam02, applyIctcp, applyLchClarity, applyBradford, applySatLum, acesCurve, applyAces, filmicCurve, applyFilmic, hableCurve, applyReinhard, channelArrays, applyGrain, applyVignette, applyCA, applyAWB, applyFreqSep, applyMicro, applyFilmSim, applyHdrPq, applyDither, applySelDesat, c01, sCurve01, lum709, blurChannels, blendFull, applyRetinex, applyLocalLaplacian, applyGuidedDetail, applyAutoLevels, applySCurveRGB, applyKodak2383, applyLogToneMap, applyMantiuk, applyDrago, wbGains, applyWBGains, applyVonKries, applyYCbCrChroma, applyProPhoto, applyDisplayP3, applyLabFilter, rgbToHsv01, hsvToRgb255, applyHslSCurve, applyHsvValuePop, applySelectiveColor, applyColorGrading, applyKelvin, kelvinRaw, kelvinGains, applyWBTemp, applyToneMapGene, applyToneMap2, applySaturationModel, applySelectiveHue, isFixedNeutral, subGenesOf, geneParams, paramsNeutral, applyCurves, applyCrossProcess, applyBleachBypass, applyFadedMatte, lutC01, lutSat, lutCurve, lutAces, applyOp, processGenomeFd, processGenome, floydSteinbergQuantize, oklabToSrgbFloat, hybridQuantize ];
function buildWorkerSource(){
  var plain={ XN:XN, YN:YN, ZN:ZN, DELTA:DELTA, D3:D3, TD2:TD2, ENC_N:ENC_N,
    CAT16:CAT16, INV_CAT16:INV_CAT16, OPP_MAT:OPP_MAT, INV_OPP:INV_OPP, HCT_FL:HCT_FL, HCT_RGBD:HCT_RGBD,
    JZ_LMS:JZ_LMS, INV_JZ_LMS:INV_JZ_LMS, JZ_OPP:JZ_OPP, INV_JZ_OPP:INV_JZ_OPP,
    PQ_M1:PQ_M1, PQ_M2:PQ_M2, PQ_C1:PQ_C1, PQ_C2:PQ_C2, PQ_C3:PQ_C3, UN:UN, VN:VN,
    IPT_LMS:IPT_LMS, INV_IPT_LMS:INV_IPT_LMS, IPT_MAT:IPT_MAT, INV_IPT_MAT:INV_IPT_MAT,
    AGX_IN:AGX_IN, AGX_OUT:AGX_OUT, AGX_MIN_EV:AGX_MIN_EV, AGX_RANGE:AGX_RANGE, TONEMAP_GAIN:TONEMAP_GAIN,
    CAT02:CAT02, INV_CAT02:INV_CAT02, CAM02_RGBD:CAM02_RGBD,
    ICTCP_LMS:ICTCP_LMS, INV_ICTCP_LMS:INV_ICTCP_LMS, ICTCP_M:ICTCP_M, INV_ICTCP_M:INV_ICTCP_M,
    BFD:BFD, INV_BFD:INV_BFD, BAYER8:BAYER8, P3_M:P3_M, INV_P3_M:INV_P3_M, LUT_SIZE:LUT_SIZE };
  var parts=[];
  parts.push("\"use strict\";");
  parts.push("var SRGB_TO_LINEAR=new Float32Array("+JSON.stringify(Array.from(SRGB_TO_LINEAR))+");");
  parts.push("var LINEAR_TO_SRGB=new Float32Array("+JSON.stringify(Array.from(LINEAR_TO_SRGB))+");");
  for(var k in plain) parts.push("var "+k+"="+JSON.stringify(plain[k])+";");
  parts.push("var FILTERS="+JSON.stringify(FILTERS)+";");
  parts.push("var FBY={}; FILTERS.forEach(function(f){ FBY[f.key]=f; });");
  parts.push("var LUT_AX0=new Int32Array(256), LUT_AX1=new Int32Array(256), LUT_AXF=new Float32Array(256);"
    +"for(var av=0; av<256; av++){ var ap=av/255*(LUT_SIZE-1), a0=Math.floor(ap);"
    +" if(a0>=LUT_SIZE-1){ a0=LUT_SIZE-1; LUT_AXF[av]=0; } else { LUT_AXF[av]=ap-a0; }"
    +" LUT_AX0[av]=a0; LUT_AX1[av]= a0<LUT_SIZE-1 ? a0+1 : a0; }");
  parts.push("var JOB_LUTS={};");
  /* Igual que applyLut3D del hilo principal, pero leyendo las LUT del trabajo actual */
  parts.push("function applyLut3D(d, amount, lutId){"
    +" if(amount===0) return;"
    +" var id=Math.round(lutId);"
    +" var data=JOB_LUTS[id]; if(!data) return;"
    +" var S=Math.round(Math.cbrt(data.length/3)), inv=1-amount, S1=S-1;"
    +" for(var i=0;i<d.length;i+=4){"
    +"  var oR=d[i], oG=d[i+1], oB=d[i+2];"
    +"  var ap=oR/255*S1, x0, x1, fx;"
    +"  if(ap>=S1){ x0=S1; x1=S1; fx=0; } else if(ap<=0){ x0=0; x1=1; fx=0; } else { x0=Math.floor(ap); x1=x0+1; fx=ap-x0; }"
    +"  var aq=oG/255*S1, y0, y1, fy;"
    +"  if(aq>=S1){ y0=S1; y1=S1; fy=0; } else if(aq<=0){ y0=0; y1=1; fy=0; } else { y0=Math.floor(aq); y1=y0+1; fy=aq-y0; }"
    +"  var ar=oB/255*S1, z0, z1, fz;"
    +"  if(ar>=S1){ z0=S1; z1=S1; fz=0; } else if(ar<=0){ z0=0; z1=1; fz=0; } else { z0=Math.floor(ar); z1=z0+1; fz=ar-z0; }"
    +"  var i000=((z0*S+y0)*S+x0)*3, i100=((z0*S+y0)*S+x1)*3;"
    +"  var i010=((z0*S+y1)*S+x0)*3, i110=((z0*S+y1)*S+x1)*3;"
    +"  var i001=((z1*S+y0)*S+x0)*3, i101=((z1*S+y0)*S+x1)*3;"
    +"  var i011=((z1*S+y1)*S+x0)*3, i111=((z1*S+y1)*S+x1)*3;"
    +"  for(var c=0;c<3;c++){"
    +"   var v00=data[i000+c] + fx*(data[i100+c]-data[i000+c]);"
    +"   var v10=data[i010+c] + fx*(data[i110+c]-data[i010+c]);"
    +"   var v01=data[i001+c] + fx*(data[i101+c]-data[i001+c]);"
    +"   var v11=data[i011+c] + fx*(data[i111+c]-data[i011+c]);"
    +"   var v0=v00 + fy*(v10-v00), v1=v01 + fy*(v11-v01);"
    +"   var v=(v0 + fz*(v1-v0))*255;"
    +"   var orig= c===0?oR : c===1?oG : oB;"
    +"   d[i+c]=clamp255(orig*inv + v*amount);"
    +"  }"
    +" }"
    +"}");
  for(var i=0;i<CPU_ENGINE_FNS.length;i++) parts.push(CPU_ENGINE_FNS[i].toString());
  parts.push("self.onmessage=function(e){ var m=e.data;"
    +" try{"
    +"  JOB_LUTS={}; for(var id in m.luts) JOB_LUTS[id]=new Float32Array(m.luts[id]);"
    +"  var img={ data:new Uint8ClampedArray(m.pixels), width:m.width, height:m.height };"
    +"  processGenome(img, m.genome, m.dith||null);"
    +"  self.postMessage({ id:m.id, ok:true, pixels:img.data.buffer }, [img.data.buffer]);"
    +" }catch(err){"
    +"  try{ self.postMessage({ id:m.id, ok:false, error:String((err&&err.message)||err) }); }catch(e2){}"
    +" }"
    +"};");
  return parts.join("\n");
}
var CpuPool=(function(){
  var workers=null, failed=false;
  var runId=0, queue=[], doneCount=0, total=0, progressCb=null, doneCb=null, baseData=null, finished=true, jobDith=null;
  function ensure(){
    if(workers) return true;
    if(failed) return false;
    try{
      if(typeof Worker==="undefined" || typeof Blob==="undefined" || typeof URL==="undefined" || !URL.createObjectURL){ failed=true; return false; }
      var src=buildWorkerSource();
      var url=URL.createObjectURL(new Blob([src], {type:"text/javascript"}));
      var n=(typeof navigator!=="undefined" && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4;
      if(n<1) n=1;
      if(n>POP_SIZE) n=POP_SIZE; /* un worker por vista previa: más no se pueden ocupar */
      workers=[];
      for(var i=0;i<n;i++){
        var w=new Worker(url);
        w._busy=false; w._job=null;
        (function(wk){
          wk.onmessage=function(ev){ onWorkerMessage(wk, ev.data); };
          wk.onerror=function(){ failPool(); };
        })(w);
        workers.push(w);
      }
      return true;
    }catch(e){ failed=true; workers=null; return false; }
  }
  /* Solo las LUT que el genoma activa de verdad (las demás viajan como coste cero) */
  function lutIdsFor(genome){
    var out=[];
    for(var i=0;i<genome.order.length;i++){
      var key=genome.order[i];
      if(key.slice(0,3)!=="lut") continue;
      var f=FBY[key]; if(!f) continue;
      var v=genome.values[key];
      if(v===f.def || v===undefined) continue;
      out.push(parseInt(key.slice(3),10));
    }
    return out;
  }
  function paint(job, buf){
    try{
      var img=new ImageData(new Uint8ClampedArray(buf), TW, TH);
      job.canvas.getContext("2d").putImageData(img, 0, 0);
    }catch(e){ renderThumbCpu(job.canvas, job.genome); }
  }
  function complete(job){
    doneCount++;
    if(progressCb) progressCb(doneCount, total);
    if(!finished && doneCount>=total){
      finished=true;
      var cb=doneCb; doneCb=null;
      if(cb) cb();
    }
  }
  function onWorkerMessage(w, msg){
    var job=w._job;
    w._busy=false; w._job=null;
    if(job && job._run===runId && msg && msg.id===job._seq){
      if(msg.ok) paint(job, msg.pixels);
      else renderThumbCpu(job.canvas, job.genome); /* ese genoma concreto se rehace en el hilo principal */
      complete(job);
    }
    dispatch(w);
  }
  function failPool(){
    if(failed) return;
    failed=true;
    var rest=queue.splice(0);
    if(workers){
      workers.forEach(function(w){
        if(w._job && w._job._run===runId) rest.push(w._job);
        w._job=null; w._busy=false;
        try{ w.terminate(); }catch(e){}
      });
      workers=null;
    }
    /* Degradación con gracia: lo que falte de esta tanda se termina en un solo hilo */
    rest.forEach(function(job){
      if(job._run!==runId) return;
      renderThumbCpu(job.canvas, job.genome);
      complete(job);
    });
  }
  function dispatch(w){
    if(!workers || w._busy || !queue.length) return;
    var job=queue.shift();
    w._busy=true; w._job=job;
    try{
      var luts={}, transfer=[];
      lutIdsFor(job.genome).forEach(function(lid){
        var copy=getRenderLut(lid).data.slice(); /* copia: la rejilla de render (65³ si ya se generó, 33³ en la fase de genes) */
        luts[lid]=copy.buffer;
        transfer.push(copy.buffer);
      });
      var px=new Uint8ClampedArray(baseData.data);
      transfer.push(px.buffer);
      w.postMessage({ id:job._seq, width:TW, height:TH, pixels:px.buffer,
        genome:{ values:job.genome.values, order:job.genome.order }, luts:luts, dith:jobDith }, transfer);
    }catch(e){
      w._busy=false; w._job=null;
      queue.unshift(job);
      failPool();
    }
  }
  /* jobs: [{canvas, genome}]; base: ImageData de la miniatura original.
     Devuelve false si el pool no está disponible (el llamador degrada). */
  function render(jobs, base, onProgress, onAllDone, dith){
    if(!base || !jobs.length) return false;
    if(!ensure()) return false;
    runId++;
    queue=jobs.slice();
    total=jobs.length; doneCount=0;
    progressCb=onProgress; doneCb=onAllDone; baseData=base; finished=false; jobDith=dith||null;
    for(var i=0;i<queue.length;i++){ queue[i]._seq=i; queue[i]._run=runId; }
    workers.forEach(dispatch);
    return true;
  }
  return { render:render };
})();

/* ==================================================================
   Aceleración por GPU (WebGL2)
   El mismo genoma se ejecuta como una cadena de pasadas de shaders:
   cada filtro es un fragment shader (programas cacheados, compilados
   una sola vez), las LUT 3D viven en texturas 3D con interpolación
   trilineal por hardware y los filtros con blur usan pasadas de box
   blur separable sobre la GPU. Las miniaturas, la vista previa y la
   exportación a resolución completa pasan por aquí. Si WebGL2 no
   está disponible o algo falla, se vuelve a processGenome (CPU).
   ================================================================== */
var GPU=(function(){
"use strict";
var gl=null, glCanvas=null, fbo=null, vertShader=null;
var inited=false, okFlag=false, broken=false, maxTexSize=0;
var progCache={}, texSize=new Map(), poolMap={}, poolFMap={};
var srcCache=new Map(), srcTexSet=new Set(), lutCache={}, bayerTex=null;
var sampleTex=null, sampleFTex=null, sampleBuf=new Uint8Array(64*64*4), sampleFBuf=new Float32Array(64*64*4);
var f32Checked=false, f32OK=false;
var lutFmtChecked=false, lutFmt=0; /* 0 = sin filtrado lineal float, 1 = RGBA32F, 2 = RGBA16F */
var jobW=0, jobH=0, jobCur=null;
var SAMPLERS=["uTex","uBlur","uBlur2","uBlur3","uRaw","uLut","uBayer"];

var VERT="#version 300 es\nout vec2 vUv;\nvoid main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }";
var FHEAD="#version 300 es\nprecision highp float;\nprecision highp int;\nin vec2 vUv;\nout vec4 O;\n"
+"uniform sampler2D uTex;\nuniform sampler2D uBlur;\nuniform sampler2D uBlur2;\nuniform sampler2D uBlur3;\nuniform sampler2D uRaw;\nuniform sampler2D uBayer;\nuniform sampler3D uLut;\n"
+"uniform vec2 uRes;\nuniform float uV;\nuniform float uLutN;\nuniform float uV2;\nuniform float uV3;\nuniform float uFL;\nuniform float uEncode;\nuniform vec3 uColA;\nuniform vec3 uColB;\nuniform vec3 uGain;\nuniform vec3 uLo;\nuniform vec3 uHi;\n";
var XYZM="0.4124564,0.3575761,0.1804375,0.2126729,0.7151522,0.0721750,0.0193339,0.1191920,0.9503041";
var LXYZM="3.2404542,-1.5371385,-0.4985314,-0.9692660,1.8760108,0.0415560,0.0556434,-0.2040259,1.0572252";
var HELP=[
"float clamp01(float x){ return clamp(x,0.0,1.0); }",
"vec3 clamp01v(vec3 x){ return clamp(x,0.0,1.0); }",
"float lin1(float c){ return c<=0.04045 ? c/12.92 : pow((c+0.055)/1.055,2.4); }",
"vec3 lin3(vec3 c){ return vec3(lin1(c.r),lin1(c.g),lin1(c.b)); }",
"float enc1(float c){ c=max(c,0.0); return c<=0.0031308 ? 12.92*c : 1.055*pow(c,1.0/2.4)-0.055; }",
"vec3 enc3(vec3 c){ return vec3(enc1(c.r),enc1(c.g),enc1(c.b)); }",
"float spow(float x,float e){ return sign(x)*pow(abs(x),e); }",
"vec3 mul9(vec3 v,float a,float b,float c,float d,float e,float f,float g,float h,float i){ return vec3(a*v.x+b*v.y+c*v.z, d*v.x+e*v.y+f*v.z, g*v.x+h*v.y+i*v.z); }",
"vec3 xyzLin(vec3 l){ return mul9(l,"+XYZM+"); }",
"vec3 linFromXyz(vec3 x){ return mul9(x,"+LXYZM+"); }",
"float lum299(vec3 c){ return dot(c,vec3(0.299,0.587,0.114)); }",
"float lum709(vec3 c){ return dot(c,vec3(0.2126,0.7152,0.0722)); }",
"float smooth01(float t){ t=clamp01(t); return t*t*(3.0-2.0*t); }",
"float sCurve01(float x,float k){ x=clamp01(x); float ss=x*x*(3.0-2.0*x); return clamp01((1.0-0.55*k)*x+0.55*k*ss); }",
"vec3 sCurve3(vec3 c,float k){ return vec3(sCurve01(c.r,k),sCurve01(c.g,k),sCurve01(c.b,k)); }",
"vec3 toOklab(vec3 rgb){ vec3 lms=mul9(lin3(rgb), 0.4122214708,0.5363325363,0.0514459929, 0.2119034982,0.6806995451,0.1073969566, 0.0883024619,0.2817188376,0.6299787005); lms=vec3(spow(lms.x,1.0/3.0),spow(lms.y,1.0/3.0),spow(lms.z,1.0/3.0)); return mul9(lms, 0.2104542553,0.7936177850,-0.0040720468, 1.9779984951,-2.4285922050,0.4505937099, 0.0259040371,0.7827717662,-0.8086757660); }",
"vec3 fromOklab(vec3 lab){ vec3 lms=mul9(lab, 1.0,0.3963377774,0.2158037573, 1.0,-0.1055613458,-0.0638541728, 1.0,-0.0894841775,-1.2914855480); lms=lms*lms*lms; return clamp01v(enc3(mul9(lms, 4.0767416621,-3.3077115913,0.2309699292, -1.2684380046,2.6097574011,-0.3413193965, -0.0041960863,-0.7034186147,1.7076147010))); }",
"float labF(float t){ return t>0.0088564517 ? pow(t,1.0/3.0) : t/0.1284185493+0.1379310345; }",
"float labFInv(float t){ return t>0.2068965517 ? t*t*t : 0.1284185493*(t-0.1379310345); }",
"vec3 toLab(vec3 rgb){ vec3 xyz=xyzLin(lin3(rgb))*vec3(100.0/95.047,1.0,100.0/108.883); vec3 f=vec3(labF(xyz.x),labF(xyz.y),labF(xyz.z)); return vec3(116.0*f.y-16.0, 500.0*(f.x-f.y), 200.0*(f.y-f.z)); }",
"vec3 fromLab(vec3 lab){ float fy=(lab.x+16.0)/116.0; float fx=fy+lab.y/500.0; float fz=fy-lab.z/200.0; vec3 xyz=vec3(labFInv(fx)*95.047, labFInv(fy)*100.0, labFInv(fz)*108.883)/100.0; return clamp01v(enc3(linFromXyz(xyz))); }",
"float pqEnc(float e){ if(e<=0.0) return 0.0; float t=pow(e,0.1593017578125); return pow((0.8359375+18.8515625*t)/(1.0+18.6875*t),78.84375); }",
"float pqDec(float y){ if(y<=0.0) return 0.0; y=min(y,1.0); float root=pow(y,1.0/78.84375); float den=18.8515625-root*18.6875; if(den<=0.0) return 1.0; float t=(root-0.8359375)/den; if(t<=0.0) return 0.0; return pow(t,1.0/0.1593017578125); }",
"float camResp(float v){ float t=pow(uFL*abs(v)/100.0,0.42); return sign(v)*400.0*t/(t+27.13); }",
"float camRespInv(float r){ float ar=min(abs(r),399.999); float p=27.13*ar/(400.0-ar); float t=pow(p,1.0/0.42); return sign(r)*t*100.0/uFL; }",
"float hueOf(vec3 c,float mx,float dl){ float h=0.0; if(dl>1e-9){ if(mx==c.r) h=60.0*mod((c.g-c.b)/dl,6.0); else if(mx==c.g) h=60.0*((c.b-c.r)/dl+2.0); else h=60.0*((c.r-c.g)/dl+4.0); } return h; }",
"vec3 sectors(float h,float cc,float x,float m){ vec3 rgb=vec3(0.0); if(h<60.0) rgb=vec3(cc,x,0.0); else if(h<120.0) rgb=vec3(x,cc,0.0); else if(h<180.0) rgb=vec3(0.0,cc,x); else if(h<240.0) rgb=vec3(0.0,x,cc); else if(h<300.0) rgb=vec3(x,0.0,cc); else rgb=vec3(cc,0.0,x); return rgb+m; }",
"vec3 rgb2hsl(vec3 c){ float mx=max(c.r,max(c.g,c.b)); float mn=min(c.r,min(c.g,c.b)); float dl=mx-mn; float L=(mx+mn)*0.5; float den=1.0-abs(2.0*L-1.0); float S= dl<1e-9 ? 0.0 : dl/(den<1e-9?1.0:den); return vec3(hueOf(c,mx,dl),S,L); }",
"vec3 hsl2rgb(vec3 hsl){ float h=mod(hsl.x,360.0); float cc=(1.0-abs(2.0*hsl.z-1.0))*hsl.y; float x=cc*(1.0-abs(mod(h/60.0,2.0)-1.0)); return sectors(h,cc,x,hsl.z-cc*0.5); }",
"vec3 rgb2hsv(vec3 c){ float mx=max(c.r,max(c.g,c.b)); float mn=min(c.r,min(c.g,c.b)); float dl=mx-mn; float s= mx>0.0 ? dl/mx : 0.0; return vec3(hueOf(c,mx,dl),s,mx); }",
"vec3 hsv2rgb(vec3 hsv){ float h=mod(hsv.x,360.0); float cc=hsv.z*hsv.y; float x=cc*(1.0-abs(mod(h/60.0,2.0)-1.0)); return sectors(h,cc,x,hsv.z-cc); }",
"float agxMap(float x){ float u=clamp((log2(max(x,1e-10))+12.47393)/16.499999,0.0,1.0); float x2=u*u; float x3=x2*u; float x4=x2*x2; float x5=x4*u; float x6=x3*x3; return clamp(15.5*x6-40.14*x5+31.96*x4-6.868*x3+0.4298*x2+0.1191*u-0.00232,0.0,1.0); }",
"float filmicF(float x){ return clamp((x*(6.2*x+0.5))/(x*(6.2*x+1.7)+0.06),0.0,1.0); }",
"float hableF(float x){ return (x*(0.15*x+0.05)+0.004)/(x*(0.15*x+0.5)+0.06)-0.02/0.30; }"
].join("\n")+"\n";

function fmtM(a){ var s=""; for(var i=0;i<9;i++){ if(i) s+=","; s+=(+a[i]).toPrecision(8); } return s; }
function hctBody(cat, invCat){
  return "vec3 xyz=mul9(lin3(c),"+XYZM+")*100.0;"
  +"vec3 lms=mul9(xyz,"+fmtM(cat)+")*uColA;"
  +"lms=vec3(camResp(lms.x),camResp(lms.y),camResp(lms.z));"
  +"float Ap=2.0*lms.x+lms.y+0.05*lms.z;"
  +"float aa=(lms.x-1.0909090909*lms.y+0.0909090909*lms.z)*uV;"
  +"float bb=((lms.x+lms.y-2.0*lms.z)/9.0)*uV;"
  +"vec3 rr=mul9(vec3(Ap,aa,bb),"+fmtM(INV_OPP)+");"
  +"vec3 lms2=vec3(camRespInv(rr.x),camRespInv(rr.y),camRespInv(rr.z))/uColA;"
  +"vec3 xyz2=mul9(lms2,"+fmtM(invCat)+")/100.0;"
  +"c=clamp01v(enc3(mul9(xyz2,"+LXYZM+")));";
}
/* Cuerpos por filtro: operan sobre vec3 c (sRGB 0-1) del píxel actual */
var PB={
lin:"float l=lum299(c); c=clamp01v(l+(c-l)*uV);",
cielch:"vec3 lab=toLab(c); if(length(lab.yz)>0.0) lab.yz*=uV2; c=fromLab(lab);",
oklch:"vec3 o=toOklab(c); o.yz*=uV; c=fromOklab(o);",
vib:"vec3 c255=c*255.0; float mx=max(c.r,max(c.g,c.b)); float mn=min(c.r,min(c.g,c.b)); float sat= mx>0.0 ? (mx-mn)/mx : 0.0; float weight=1.0-sat; float skin=0.0; if(c255.r>c255.g && c255.g>c255.b){ float dd=c255.r-c255.b; if(dd>=18.0 && dd<=110.0 && c255.r>=90.0){ float hue=degrees(atan(sqrt(3.0)*(c255.g-c255.b), 2.0*c255.r-c255.g-c255.b)); if(hue<0.0) hue+=360.0; if(hue>=8.0 && hue<=52.0) skin=1.0; } } weight*=mix(1.0,0.3,skin); float f=1.0+uV*weight*1.35; float lum=lum299(c); c=clamp01v(lum+(c-lum)*f);",
con:"vec3 o=toOklab(c); float Lc=clamp(o.x,0.0,1.0); o.x+=uV*3.0*Lc*(1.0-Lc)*(Lc-0.5); c=fromOklab(o);",
temp:"vec3 o=toOklab(c); o.z+=uV*0.07; c=fromOklab(o);",
hct:hctBody(CAT16, INV_CAT16),
ciecam02:hctBody(CAT02, INV_CAT02),
jz:"vec3 xyz=mul9(lin3(c),"+XYZM+"); vec3 lms=mul9(xyz,"+fmtM(JZ_LMS)+"); lms=vec3(pqEnc(lms.x),pqEnc(lms.y),pqEnc(lms.z)); float Iz=0.5*lms.x+0.5*lms.y; float Az=(3.524*lms.x-4.066708*lms.y+0.542708*lms.z)*uV; float Bz=(0.199076*lms.x+1.096799*lms.y-1.295875*lms.z)*uV; vec3 l2=mul9(vec3(Iz,Az,Bz),"+fmtM(INV_JZ_OPP)+"); l2=vec3(pqDec(l2.x),pqDec(l2.y),pqDec(l2.z)); vec3 xyz2=mul9(l2,"+fmtM(INV_JZ_LMS)+"); c=clamp01v(enc3(mul9(xyz2,"+LXYZM+")));",
hsluv:"vec3 xyz=mul9(lin3(c),"+XYZM+")*100.0; float den=xyz.x+15.0*xyz.y+3.0*xyz.z; if(den!=0.0 && xyz.y!=0.0){ float up=4.0*xyz.x/den; float vp=9.0*xyz.y/den; float yr=xyz.y/100.0; float L= yr>0.0088564517 ? 116.0*pow(yr,1.0/3.0)-16.0 : 903.3*yr; if(L>0.0){ float du=up-("+UN.toPrecision(8)+"); float dv=vp-("+VN.toPrecision(8)+"); float fEff=uV; if(uV>1.0){ if(dv<0.0) fEff=min(fEff,(0.02-("+VN.toPrecision(8)+"))/dv); else if(dv>0.0) fEff=min(fEff,(0.65-("+VN.toPrecision(8)+"))/dv); if(du<0.0) fEff=min(fEff,(0.0-("+UN.toPrecision(8)+"))/du); else if(du>0.0) fEff=min(fEff,(0.65-("+UN.toPrecision(8)+"))/du); if(fEff<0.0) fEff=0.0; } float us=13.0*L*du*fEff; float vs=13.0*L*dv*fEff; float upo=us/(13.0*L)+("+UN.toPrecision(8)+"); float vpo=vs/(13.0*L)+("+VN.toPrecision(8)+"); if(vpo!=0.0){ float Yo= L>8.0 ? 100.0*pow((L+16.0)/116.0,3.0) : L/903.3*100.0; float Xo=Yo*(9.0*upo)/(4.0*vpo); float Zo=Yo*(12.0-3.0*upo-20.0*vpo)/(4.0*vpo); c=clamp01v(enc3(mul9(vec3(Xo,Yo,Zo)/100.0,"+LXYZM+"))); } } }",
ipt:"vec3 raw=mul9(lin3(c),"+fmtM(IPT_LMS)+"); vec3 pp=vec3(spow(raw.x,0.43),spow(raw.y,0.43),spow(raw.z,0.43)); float I=0.4*pp.x+0.4*pp.y+0.2*pp.z; float P=(-4.455*pp.x+4.851*pp.y-0.396*pp.z)*uV; float T=(0.8056*pp.x-0.3572*pp.y-0.4484*pp.z)*uV; vec3 p2=mul9(vec3(I,P,T),"+fmtM(INV_IPT_MAT)+"); vec3 raw2=vec3(spow(p2.x,1.0/0.43),spow(p2.y,1.0/0.43),spow(p2.z,1.0/0.43)); c=clamp01v(enc3(mul9(raw2,"+fmtM(INV_IPT_LMS)+")));",
ictcp:"vec3 lv=lin3(c); vec3 raw=mul9(lv,"+fmtM(ICTCP_LMS)+"); vec3 lms=vec3(pqEnc(raw.x),pqEnc(raw.y),pqEnc(raw.z)); float I=0.5*lms.x+0.5*lms.y; float Ct=(1.6138*lms.x-3.3235*lms.y+1.7097*lms.z)*uV; float Cp=(4.3782*lms.x-4.6392*lms.y+0.2610*lms.z)*uV; vec3 l2=mul9(vec3(I,Ct,Cp),"+fmtM(INV_ICTCP_M)+"); l2=vec3(pqDec(l2.x),pqDec(l2.y),pqDec(l2.z)); c=clamp01v(enc3(mul9(l2,"+fmtM(INV_ICTCP_LMS)+")));",
agx:"vec3 t=mul9(lin3(c),"+fmtM(AGX_IN)+"); t=vec3(agxMap(t.x),agxMap(t.y),agxMap(t.z)); c=mix(c, clamp01v(enc3(mul9(t,"+fmtM(AGX_OUT)+"))), uV);",
exp:"c=clamp01v(enc3(lin3(c)*pow(2.0,uV)));",
tonezone:"float l=lum299(c); float w=0.0; int mode=int(uV2+0.5); if(mode==0) w=smooth01((l-0.35)/0.65); else if(mode==1) w=pow(1.0-l,2.2); else if(mode==2) w=smooth01((l-0.68)/0.32); else w=smooth01((0.32-l)/0.32); float f=1.0+uV*0.55*w; float lift= (mode==1||mode==3) ? uV*w*(20.0/255.0) : 0.0; c=clamp01v(c*f+lift);",
gamma:"c=clamp01v(pow(c,vec3(1.0/uV)));",
tintgm:"float s=uV*(18.0/255.0); c=clamp01v(c+vec3(s,-s,s));",
huerot:"vec3 hsl=rgb2hsl(c); hsl.x=mod(hsl.x+uV,360.0); c=hsl2rgb(hsl);",
split:"float l=lum299(c); vec3 add=((uColA-(128.0/255.0))*(1.0-l)+(uColB-(128.0/255.0))*l)*(uV*0.5); c=clamp01v(c+add);",
duotone:"float l=lum299(c); c=mix(c, mix(uColA,uColB,l), uV);",
huerotok:"vec3 o=toOklab(c); float a2=o.y*uV2-o.z*uV3; float b2=o.y*uV3+o.z*uV2; o.y=a2; o.z=b2; c=fromOklab(o);",
lchclarity:"vec3 lab=toLab(c); float t=lab.x/100.0; float tn=clamp(t+uV*3.0*t*(1.0-t)*(t-0.5),0.0,1.0); lab.x=tn*100.0; c=fromLab(lab);",
bradford:"vec3 lms=mul9(xyzLin(lin3(c)),"+fmtM(BFD)+"); lms.x*=1.0+0.14*uV; lms.z*=1.0-0.20*uV; c=clamp01v(enc3(linFromXyz(mul9(lms,"+fmtM(INV_BFD)+"))));",
satlum:"float lum=lum299(c); float f=max(1.0+uV*1.5*(1.0-lum)*(0.35+0.65*(1.0-lum)),0.0); c=clamp01v(lum+(c-lum)*f);",
aces:"vec3 x=lin3(c)*1.6; vec3 ac=clamp01v(x*(2.51*x+0.03)/(x*(2.43*x+0.59)+0.14)); c=mix(c, clamp01v(enc3(ac)), uV);",
filmic:"vec3 x=lin3(c)*3.2; vec3 fv=vec3(filmicF(x.r),filmicF(x.g),filmicF(x.b))/uV2; c=mix(c, clamp01v(enc3(fv)), uV);",
reinhard:"vec3 lv=lin3(c); vec3 hab=enc3(max(vec3(hableF(lv.r*3.0),hableF(lv.g*3.0),hableF(lv.b*3.0))/uV2, vec3(0.0))); vec3 rei=enc3(lv/(1.0+lv)*1.9); c=mix(c, clamp01v((hab+rei)*0.5), uV);",
grain:"float n=fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453); float l=lum299(c); float g=(n-0.5)*(uV*(44.0/255.0))*(1.15-abs(l-0.5)); c=clamp01v(c+g);",
vignette:"vec2 pc=gl_FragCoord.xy-0.5; vec2 cen=(uRes-1.0)*0.5; float maxD=length(cen); vec2 dd=(pc-cen)/max(maxD,1.0); float r2=dot(dd,dd); float f=max(1.0-uV*0.6*pow(r2,1.4),0.05); c=clamp01v(c*f);",
dither:"float bv=texture(uBayer, gl_FragCoord.xy/8.0).r*255.0; float dv=(bv/64.0-0.5)*(uV*(15.0/255.0)); c=clamp01v(c+dv);",
seldesat:"vec3 hsl=rgb2hsl(c); float diff=abs(hsl.x-uV2); if(diff>180.0) diff=360.0-diff; float keep=smooth01((75.0-diff)/75.0); float desat=uV*(1.0-keep); if(desat>0.0) c=mix(c, vec3(lum299(c)), clamp01(desat));",
ca:"vec2 cen=(uRes-1.0)*0.5; vec2 pc=gl_FragCoord.xy-0.5; vec2 dd=vec2(cen.x>0.0 ? (pc.x-cen.x)/cen.x : 0.0, cen.y>0.0 ? (pc.y-cen.y)/cen.y : 0.0); float r=length(dd); float s=uV*r; ivec2 sz=ivec2(uRes)-1; ivec2 pr=clamp(ivec2(round(pc+dd*s)), ivec2(0), sz); ivec2 pb=clamp(ivec2(round(pc-dd*s)), ivec2(0), sz); c.r=texelFetch(uTex,pr,0).r; c.b=texelFetch(uTex,pb,0).b;",
filmsim:"float lum=lum299(c); vec3 nc=c; if(uV2<0.5){ nc=c*vec3(1.03,1.0,0.94)+vec3(7.0,3.0,-3.0)/255.0; nc=lum+(nc-lum)*0.92; } else if(uV2<1.5){ nc=lum+(c-lum)*vec3(1.35,1.4175,1.35); nc*=vec3(1.04,1.0,1.05); } else { float sh=1.0-lum; nc=c+vec3(lum*14.0-sh*6.0, sh*10.0-lum*2.0, sh*16.0-lum*6.0)/255.0; nc=lum+(nc-lum)*1.1; } c=clamp01v(mix(c,nc,uV));",
hdrpq:"vec3 lv=lin3(c); vec3 comp=(1.0-exp(-lv*2.4))/(1.0-exp(-2.4)); c=mix(c, clamp01v(enc3(comp)), uV);",
autolevels:"vec3 full=clamp01v((c-uLo)/max(uHi-uLo, vec3(0.00001))); c=mix(c, full, uV);",
scurve:"c=sCurve3(c, 0.9*uV);",
kodak2383:"vec3 t=sCurve3(c,0.7)*vec3(1.06,1.0,0.94); float L=lum709(t); c=mix(c, clamp01v(L+(t-L)*1.15), uV);",
logtone:"float L=lum709(c); float ratio= L>0.01 ? (log(1.0+L*uColA.x)/log(1.0+uColA.x))/L : 1.0; float f=1.0-uV+uV*(uColA.y+uColA.z*ratio); c=clamp01v(c*f);",
gains:"c=clamp01v(c*uGain);",
vonkries:"vec3 lms=mul9(lin3(c),"+fmtM(IPT_LMS)+"); lms.x*=1.0+0.05*uV; lms.z*=1.0-0.08*uV; c=clamp01v(enc3(mul9(lms,"+fmtM(INV_IPT_LMS)+")));",
ycbcr:"float Y=lum709(c); float f=1.0+0.45*uV; float cb=0.5+(c.b-Y)*0.564*f; float cr=0.5+(c.r-Y)*0.713*f; c=clamp01v(vec3(Y+1.402*(cr-0.5), Y-0.344*(cb-0.5)-0.714*(cr-0.5), Y+1.772*(cb-0.5)));",
prophoto:"vec3 lv=lin3(c); float l=(lv.r+lv.g+lv.b)/3.0; c=clamp01v(enc3(l+(lv-l)*(1.0+0.5*uV)));",
displayp3:"vec3 p=mul9(c,"+fmtM(P3_M)+"); float L=lum709(p); float f=1.0+0.25*uV; p=L+(p-L)*f; c=clamp01v(mul9(p,"+fmtM(INV_P3_M)+"));",
labrotate:"vec3 lab=toLab(c); float ang=15.0*uV*0.0174532925; float cs=cos(ang); float sn=sin(ang); float na=lab.y*cs-lab.z*sn; lab.z=lab.y*sn+lab.z*cs; lab.y=na; c=fromLab(lab);",
din99:"vec3 lab=toLab(c); lab.yz*=1.0+0.45*uV; c=fromLab(lab);",
cam16jmh:"vec3 lab=toLab(c); float cf=1.0+uV*(0.15+0.35*(1.0-lab.x/100.0)); lab.yz*=cf; c=fromLab(lab);",
hslscurve:"vec3 hsl=rgb2hsl(c); hsl.z=sCurve01(hsl.z, 0.8*uV); c=hsl2rgb(hsl);",
hsvpop:"vec3 hsv=rgb2hsv(c); float vFull=clamp01((hsv.z-0.15)/0.75); hsv.z=mix(hsv.z, vFull, uV); c=hsv2rgb(hsv);",
selcolor:"vec3 hsv=rgb2hsv(c); float hue=hsv.x/360.0; float dhR1=hue-1.0; float dhC=hue-0.5; float redMask=exp(-(hue*hue)/0.01)+exp(-(dhR1*dhR1)/0.01); float cyanMask=exp(-(dhC*dhC)/0.01); float nr=c.r*(1.0-0.25*redMask*uV)+0.1*cyanMask*c.g*uV; float ng=c.g*(1.0+0.15*cyanMask*uV); c=clamp01v(vec3(nr,ng,c.b));",
grading:"float L=lum709(c); float sh=clamp01((0.35-L)/0.35); float hi=clamp01((L-0.65)/0.35); c=clamp01v(c+vec3(0.12*hi-0.04*sh, 0.04*hi, 0.12*sh-0.05*hi)*uV);",
kelvin:"c=clamp01v(vec3(c.r*(1.0+0.12*uV), c.g, c.b*(1.0-0.12*uV)));",
wbk:"c=clamp01v(c*uColA);",
curves:"vec3 y=pow(max(c*uColA.x+uV2, vec3(0.0)), vec3(1.0/uV3)); y=y+uV*3.0*y*(1.0-y)*(y-0.5); float L=clamp(lum299(y),0.0,1.0); float ws=pow(1.0-L,2.2); float wh=smooth01((L-0.35)/0.65); float fz=1.0+uColA.y*0.55*ws+uColA.z*0.55*wh; c=clamp01v(y*fz+uColA.y*ws*(20.0/255.0));",
tonemap:"int tm=int(uV+0.5); if(tm==1){ vec3 lv=lin3(c); vec3 hab=enc3(max(vec3(hableF(lv.r*3.0),hableF(lv.g*3.0),hableF(lv.b*3.0))/uV3, vec3(0.0))); vec3 rei=enc3(lv/(1.0+lv)*1.9); c=clamp01v((hab+rei)*0.5); } else if(tm==2){ vec3 x2=lin3(c)*1.6; vec3 ac=clamp01v(x2*(2.51*x2+0.03)/(x2*(2.43*x2+0.59)+0.14)); c=clamp01v(enc3(ac)); } else if(tm==3){ vec3 x3=lin3(c)*3.2; vec3 fv=vec3(filmicF(x3.r),filmicF(x3.g),filmicF(x3.b))/uV2; c=clamp01v(enc3(fv)); } else if(tm==4){ c=sCurve3(c, 0.9); } else if(tm==5){ vec3 lv=lin3(c); vec3 av=mul9(lv,0.84247906,0.07843360,0.07922375,0.04232824,0.87846864,0.07916613,0.04237565,0.07843360,0.87914297); vec3 ay=vec3(agxMap(av.r),agxMap(av.g),agxMap(av.b)); vec3 ao=mul9(ay,1.19687901,-0.09802088,-0.09902974,-0.05289685,1.15190313,-0.09896118,-0.05297164,-0.09804345,1.15107367); c=clamp01v(enc3(ao)); }",
huesel:"vec3 hsl=rgb2hsl(c); float diff=abs(hsl.x-uV); if(diff>180.0) diff=360.0-diff; float wgt=smooth01((60.0-diff)/60.0); if(wgt>0.0){ float ang=uV2*wgt*0.0174532925; float cs=cos(ang); float sn=sin(ang); vec3 o=toOklab(c); float a2=o.y*cs-o.z*sn; float b2=o.y*sn+o.z*cs; o.y=a2; o.z=b2; c=fromOklab(o); }",
crossproc:"vec3 full=clamp01v(sCurve3(c,0.6)*vec3(1.05,1.08,0.92)); c=mix(c, full, uV);",
bleach:"float L=lum709(c); vec3 full=sCurve3(vec3(L)+(c-vec3(L))*0.55, 1.0); c=mix(c, full, uV);",
faded:"float L=lum709(c); vec3 full=clamp01v((vec3(L)+(c-vec3(L))*0.85)*0.92+0.08); c=mix(c, full, uV);"
};
/* Filtros que leen también la versión con blur de la imagen actual */
var BB={
dehaze:"vec3 bl=texelFetch(uBlur,ip,0).rgb; float a=uV; float k=a*0.85; float satF= a>0.0 ? 1.0+a*0.30 : 1.0+a*0.25; vec3 r=c+k*(bl-uColA); float lum=lum299(r); r=lum+(r-lum)*satF; float veil=-a; if(veil>0.0) r=r*(1.0-veil*0.22)+veil*0.16; c=clamp01v(r);",
clarity:"float L=lum299(c); float lb=lum299(texelFetch(uBlur,ip,0).rgb); float mid=clamp01(4.0*L*(1.0-L)); float target=clamp01(L+uV*(L-lb)*mid*1.8); if(L>0.004) c=clamp01v(c*(target/L)); else c=clamp01v(c+(target-L));",
freqsep:"vec3 bl=texelFetch(uBlur,ip,0).rgb; c=clamp01v(c+uV*1.7*(c-bl));",
micro:"float L=lum299(c); float lb=lum299(texelFetch(uBlur,ip,0).rgb); float target=clamp01(L+uV*(L-lb)*1.5); if(L>0.004) c=clamp01v(c*(target/L)); else c=clamp01v(c+(target-L));",
loclap:"vec3 bl=texelFetch(uBlur,ip,0).rgb; vec3 full=clamp01v(bl+(c-bl)*2.2); c=mix(c, full, uV);",
guided:"vec3 bl=texelFetch(uBlur,ip,0).rgb; vec3 full=clamp01v(c+(c-bl)*1.2); c=mix(c, full, uV);"
};
var BLUR_OPS={dehaze:1, clarity:1, freqsep:1, micro:1, loclap:1, guided:1};
var BLIT_FRAG=FHEAD+"void main(){ O=texture(uTex, vUv); }";
var BLUR_FRAG=FHEAD+"uniform vec2 uDir;\nuniform int uRadius;\nvoid main(){ ivec2 ip=ivec2(gl_FragCoord.xy); ivec2 maxp=ivec2(uRes)-1; vec3 sum=vec3(0.0); int taps=0; for(int i=-128;i<=128;i++){ if(i<-uRadius) continue; if(i>uRadius) break; ivec2 q=clamp(ip+ivec2(uDir)*i, ivec2(0), maxp); sum+=texelFetch(uTex,q,0).rgb; taps++; } O=vec4(sum/float(taps),1.0); }";
var LUT_FRAG=FHEAD+"void main(){ ivec2 ip=ivec2(gl_FragCoord.xy); vec3 c=texelFetch(uTex,ip,0).rgb; float N= uLutN>1.0 ? uLutN : 33.0; vec3 uvw=c*((N-1.0)/N)+(0.5/N); vec3 mapped=texture(uLut, uvw).rgb; c=mix(c, mapped, uV); O=vec4(clamp(c,0.0,1.0),1.0); }";
var RETRAW_FRAG=FHEAD+"void main(){ ivec2 ip=ivec2(gl_FragCoord.xy); vec3 c=texelFetch(uTex,ip,0).rgb; vec3 b0=texelFetch(uBlur,ip,0).rgb; vec3 b1=texelFetch(uBlur2,ip,0).rgb; vec3 b2=texelFetch(uBlur3,ip,0).rgb; vec3 lc=log(1.0+c*10.0); vec3 ret=(lc-log(1.0+b0*10.0)+lc-log(1.0+b1*10.0)+lc-log(1.0+b2*10.0))/3.0; if(uEncode>0.5) ret=ret*0.2+0.5; O=vec4(ret,1.0); }";
var RETCOMB_FRAG=FHEAD+"void main(){ ivec2 ip=ivec2(gl_FragCoord.xy); vec3 c=texelFetch(uTex,ip,0).rgb; vec3 raw=texelFetch(uRaw,ip,0).rgb; vec3 ret= uEncode>0.5 ? (raw-0.5)/0.2 : raw; vec3 norm=clamp((ret-uV2)/uV3, 0.0, 1.0); vec3 full=0.5*norm+0.5*c; c=mix(c, clamp(full,0.0,1.0), uV); O=vec4(clamp(c,0.0,1.0),1.0); }";
function pointFrag(body){ return FHEAD+HELP+"void main(){ ivec2 ip=ivec2(gl_FragCoord.xy); vec3 c=texelFetch(uTex,ip,0).rgb;\n"+body+"\nO=vec4(clamp(c,0.0,1.0),1.0); }"; }

function ensure(){
  if(inited) return okFlag;
  inited=true;
  try{
    glCanvas=document.createElement("canvas");
    gl=glCanvas.getContext("webgl2",{preserveDrawingBuffer:true, antialias:false, depth:false, stencil:false, alpha:false});
    if(!gl){ okFlag=false; return false; }
    maxTexSize=gl.getParameter(gl.MAX_TEXTURE_SIZE);
    fbo=gl.createFramebuffer();
    okFlag=true;
  }catch(e){ okFlag=false; }
  return okFlag;
}
function ok(){ return inited && okFlag && !broken; }

function compileProg(fragSrc){
  function sh(type, src){
    var s=gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){ if(window.console) console.warn("GPU shader:", gl.getShaderInfoLog(s)); gl.deleteShader(s); return null; }
    return s;
  }
  if(!vertShader){ vertShader=sh(gl.VERTEX_SHADER, VERT); if(!vertShader) return null; }
  var fs=sh(gl.FRAGMENT_SHADER, fragSrc); if(!fs) return null;
  var p=gl.createProgram(); gl.attachShader(p, vertShader); gl.attachShader(p, fs); gl.linkProgram(p); gl.deleteShader(fs);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)){ if(window.console) console.warn("GPU link:", gl.getProgramInfoLog(p)); gl.deleteProgram(p); return null; }
  return {p:p, locs:{}};
}
function getProg(name, fragSrc){
  if(name in progCache) return progCache[name];
  var pr=compileProg(fragSrc);
  progCache[name]=pr;
  return pr;
}
function loc(pr, name){
  if(!(name in pr.locs)) pr.locs[name]=gl.getUniformLocation(pr.p, name);
  return pr.locs[name];
}
function drawTo(target, pr, binds, uniforms){
  gl.useProgram(pr.p);
  if(target){
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    var s=texSize.get(target);
    gl.viewport(0,0,s.w,s.h);
  }else{
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0,0,jobW,jobH);
  }
  var unit=0;
  for(var i=0;i<SAMPLERS.length;i++){
    var nm=SAMPLERS[i], b=binds?binds[nm]:null;
    if(!b) continue;
    var l=loc(pr, nm);
    if(l) gl.uniform1i(l, unit);
    gl.activeTexture(gl.TEXTURE0+unit);
    if(nm==="uLut") gl.bindTexture(gl.TEXTURE_3D, b.tex||b);
    else gl.bindTexture(gl.TEXTURE_2D, b.tex||b);
    unit++;
  }
  if(uniforms){
    for(var name in uniforms){
      var ll=loc(pr, name); if(!ll) continue;
      var v=uniforms[name];
      if(Array.isArray(v)){ if(v.length===2) gl.uniform2f(ll, v[0], v[1]); else if(v.length===3) gl.uniform3f(ll, v[0], v[1], v[2]); }
      else if(v && typeof v==="object" && "i" in v) gl.uniform1i(ll, v.i);
      else gl.uniform1f(ll, v);
    }
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function makeTex(w, h, isFloat){
  var t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  /* Las intermedias flotantes son RGBA32F; sin filtrado lineal float
     (OES_texture_float_linear) se muestrean con NEAREST —todas las
     pasadas leen con texelFetch o copian al mismo tamaño— para que la
     textura siga siendo completa. */
  var linF= !isFloat || !!gl.getExtension("OES_texture_float_linear");
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linF?gl.LINEAR:gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linF?gl.LINEAR:gl.NEAREST);
  if(isFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  texSize.set(t, {w:w, h:h, f:isFloat?1:0});
  return t;
}
/* ¿Soporta el navegador render targets float32 (EXT_color_buffer_float
   + framebuffer RGBA32F completo)? Si sí, TODA la cadena de pasadas
   trabaja con intermedias RGBA32F; si no, se queda en RGBA8 como antes. */
function checkFloat32(){
  if(f32Checked) return f32OK;
  f32Checked=true;
  try{
    var ext=gl.getExtension("EXT_color_buffer_float");
    if(!ext){ f32OK=false; return false; }
    var t=makeTex(4,4,true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    f32OK= gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    texSize.delete(t); gl.deleteTexture(t);
  }catch(e){ f32OK=false; }
  return f32OK;
}
function acq(w, h){
  if(checkFloat32()) return acqF(w, h);
  var k=w+"x"+h, a=poolMap[k]; if(a&&a.length) return a.pop(); return makeTex(w,h,false);
}
function acqF(w, h){ var k=w+"x"+h, a=poolFMap[k]; if(a&&a.length) return a.pop(); return makeTex(w,h,true); }
function rel(t){
  if(!t || srcTexSet.has(t)) return;
  var s=texSize.get(t); if(!s) return;
  var k=s.w+"x"+s.h;
  if(s.f) (poolFMap[k]=poolFMap[k]||[]).push(t);
  else (poolMap[k]=poolMap[k]||[]).push(t);
}
function relF(t){ rel(t); }
function uploadSource(src, w, h){
  var cached=srcCache.get(src);
  if(cached) return cached;
  var t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  texSize.set(t, {w:w, h:h});
  srcCache.set(src, t); srcTexSet.add(t);
  return t;
}
function invalidateSources(){
  srcCache.forEach(function(t){ if(gl) gl.deleteTexture(t); texSize.delete(t); });
  srcCache.clear(); srcTexSet.clear();
}
var _halfF=new Float32Array(1), _halfU=new Uint32Array(_halfF.buffer);
function floatToHalf(v){
  _halfF[0]=v;
  var f=_halfU[0];
  var sign=(f>>16)&0x8000;
  var exp=((f>>23)&0xFF)-112; /* exponente con el sesgo de half (15) */
  var frac=f&0x7FFFFF;
  if(exp<=0){
    if(exp<-10) return sign;
    frac|=0x800000;
    var shift=14-exp;
    var half=frac>>shift, rem=frac&((1<<shift)-1), midway=1<<(shift-1);
    if(rem>midway || (rem===midway && (half&1))) half++;
    return sign|half;
  }
  if(exp>=31){
    if(exp===143) return sign|0x7C00|(frac?0x0200:0); /* Inf / NaN originales */
    return sign|0x7C00;
  }
  var h=sign|(exp<<10)|(frac>>13), rem2=frac&0x1FFF;
  if(rem2>0x1000 || (rem2===0x1000 && (h&1))) h++;
  return h;
}
function lutFloatFormat(){
  if(lutFmtChecked) return lutFmt;
  lutFmtChecked=true;
  try{
    if(gl.getExtension("OES_texture_float_linear")) lutFmt=1;
    else if(gl.getExtension("OES_texture_half_float_linear")) lutFmt=2;
  }catch(e){ lutFmt=0; }
  return lutFmt;
}
function makeLutTex(data, fmt, S){
  S=S||LUT_SIZE;
  var n=S*S*S, i, o, s3;
  var t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, t);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if(fmt===1){
    var rgba=new Float32Array(n*4);
    for(i=0;i<n;i++){ o=i*4; s3=i*3; rgba[o]=data[s3]; rgba[o+1]=data[s3+1]; rgba[o+2]=data[s3+2]; rgba[o+3]=1; }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, S, S, S, 0, gl.RGBA, gl.FLOAT, rgba);
  }else{
    var rgba16=new Uint16Array(n*4);
    for(i=0;i<n;i++){ o=i*4; s3=i*3; rgba16[o]=floatToHalf(data[s3]); rgba16[o+1]=floatToHalf(data[s3+1]); rgba16[o+2]=floatToHalf(data[s3+2]); rgba16[o+3]=0x3C00; }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, S, S, S, 0, gl.RGBA, gl.HALF_FLOAT, rgba16);
  }
  if(gl.getError()){ gl.deleteTexture(t); return null; }
  t._lutN=S;
  return t;
}
function getLutTex(id){
  var rl=getRenderLut(id); /* 33³ en la fase de genes; 65³ si ya se generó fuera de ella */
  var data=rl.data; if(!data) return null;
  var key=id+"@"+rl.S;
  if(lutCache[key]) return lutCache[key];
  var fmt=lutFloatFormat(); if(!fmt) return null; /* sin float lineal: la LUT va por CPU, nunca recuantizada a 8 bits */
  var t=makeLutTex(data, fmt, rl.S);
  if(!t && fmt===1 && gl.getExtension("OES_texture_half_float_linear")){ lutFmt=2; t=makeLutTex(data, 2, rl.S); }
  if(!t) return null;
  lutCache[key]=t;
  return t;
}
function invalidateLut(id){
  for(var k in lutCache){
    if(k.indexOf(id+"@")===0){
      try{ if(gl) gl.deleteTexture(lutCache[k]); }catch(e){}
      delete lutCache[k];
    }
  }
}
function getBayerTex(){
  if(bayerTex) return bayerTex;
  var data=new Uint8Array(64*4);
  for(var i=0;i<64;i++){ data[i*4]=BAYER8[i]; data[i*4+1]=BAYER8[i]; data[i*4+2]=BAYER8[i]; data[i*4+3]=255; }
  var t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  bayerTex=t;
  return t;
}

function blurOf(srcT, w, h, r){
  var pr=getProg("blurpass", BLUR_FRAG); if(!pr) throw new Error("blur shader");
  var t1=acq(w,h);
  drawTo(t1, pr, {uTex:srcT}, {uDir:[1,0], uRadius:{i:r}, uRes:[w,h]});
  var t2=acq(w,h);
  drawTo(t2, pr, {uTex:t1}, {uDir:[0,1], uRadius:{i:r}, uRes:[w,h]});
  rel(t1);
  var t3=acq(w,h);
  drawTo(t3, pr, {uTex:t2}, {uDir:[1,0], uRadius:{i:r}, uRes:[w,h]});
  var t4=acq(w,h);
  drawTo(t4, pr, {uTex:t3}, {uDir:[0,1], uRadius:{i:r}, uRes:[w,h]});
  rel(t2); rel(t3);
  return t4;
}
function blurRadius(key, w, h){
  var md=Math.min(w,h);
  switch(key){
    case "dehaze": return Math.max(8, Math.min(80, Math.round(md*0.06)));
    case "clarity": return Math.max(4, Math.min(40, Math.round(md*0.025)));
    case "freqsep": return Math.max(2, Math.min(24, Math.round(md*0.02)));
    case "micro": return 2;
    case "loclap": return 3;
    case "guided": return 2;
  }
  return 2;
}
/* Muestra 64×64 de la textura actual para estadísticas globales
   (balances de blancos, niveles, croma máximo, media de dehaze). */
function sampleStats(){
  if(!sampleTex) sampleTex=makeTex(64,64,false);
  var blit=getProg("blit", BLIT_FRAG); if(!blit) throw new Error("blit shader");
  drawTo(sampleTex, blit, {uTex:jobCur}, {});
  gl.readPixels(0,0,64,64, gl.RGBA, gl.UNSIGNED_BYTE, sampleBuf);
  return sampleBuf;
}
function statsMean(buf){
  var n=64*64, r=0,g=0,b=0;
  for(var i=0;i<buf.length;i+=4){ r+=buf[i]; g+=buf[i+1]; b+=buf[i+2]; }
  return [r/n/255, g/n/255, b/n/255];
}
function statsHist(buf){
  var hist=[new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  for(var i=0;i<buf.length;i+=4){ hist[0][buf[i]]++; hist[1][buf[i+1]]++; hist[2][buf[i+2]]++; }
  return hist;
}
function histPercentile(hist, total, q){
  var cum=0;
  for(var v=0;v<256;v++){ cum+=hist[v]; if(cum>=total*q) return v; }
  return 255;
}
function statsMaxChroma(buf){
  var maxC=0;
  for(var i=0;i<buf.length;i+=4){
    var R=srgbLin(buf[i]), G=srgbLin(buf[i+1]), B=srgbLin(buf[i+2]);
    var X=(0.4124564*R + 0.3575761*G + 0.1804375*B)*100;
    var Y=(0.2126729*R + 0.7151522*G + 0.0721750*B)*100;
    var Z=(0.0193339*R + 0.1191920*G + 0.9503041*B)*100;
    var fx=labF(X/XN), fy=labF(Y/YN), fz=labF(Z/ZN);
    var a=500*(fx-fy), b=200*(fy-fz);
    var C=Math.sqrt(a*a+b*b);
    if(C>maxC) maxC=C;
  }
  return maxC;
}
function halfToFloat(hv){
  var s=(hv>>15)&1, e=(hv>>10)&31, f=hv&1023;
  if(e===0) return (s?-1:1)*(f/1024)*Math.pow(2,-14);
  if(e===31) return f?NaN:(s?-Infinity:Infinity);
  return (s?-1:1)*Math.pow(2,e-15)*(1+f/1024);
}

function buildOps(genome){
  var ops=[];
  if(!genome) return ops;
  for(var i=0;i<genome.order.length;i++){
    var key=genome.order[i], f=FBY[key];
    if(!f) continue;
    if(typeof allowedSet!=="undefined" && allowedSet && !allowedSet[key]) continue; /* solo genes elegidos */
    if(f.key2){
      if(genome.values[key]===undefined) continue;
      var arr=geneParams(f, genome.values);
      if(paramsNeutral(key, arr)) continue;
      var op={key:key, v:arr[0]};
      for(var si=1; si<arr.length; si++) op["v"+(si+1)]=arr[si];
      ops.push(op);
    }else{
      var v=genome.values[key];
      if(v===f.def || v===undefined) continue;
      ops.push({key:key, v:v, v2:0});
    }
  }
  return ops;
}
function pointProgKey(key){
  if(key==="cam16") return "hct";
  if(key==="jzazbz") return "jz";
  if(key==="mantiuk"||key==="drago") return "logtone";
  if(key==="high"||key==="shad"||key==="whites"||key==="blacks") return "tonezone";
  if(key==="awb"||key==="grayworld"||key==="whitepatch"||key==="shadesgray") return "gains";
  return key;
}
function rgb255To01(arr){ return [arr[0]/255, arr[1]/255, arr[2]/255]; }
function pointUniforms(op, w, h){
  var u={uV:op.v, uV2:0, uV3:0, uRes:[w,h]};
  switch(op.key){
    case "high": u.uV2=0; break;
    case "shad": u.uV2=1; break;
    case "whites": u.uV2=2; break;
    case "blacks": u.uV2=3; break;
    case "split": u.uColA=rgb255To01(hslToRgb255(op.v2,65,55)); u.uColB=rgb255To01(hslToRgb255(op.v2+180,65,55)); break;
    case "duotone": u.uColA=rgb255To01(hslToRgb255(op.v2,60,16)); u.uColB=rgb255To01(hslToRgb255(op.v2+45,75,84)); break;
    case "seldesat": u.uV2=op.v2; break;
    case "huesel": u.uV2=op.v2; break;
    case "filmsim": u.uV2=op.v2; break;
    case "filmic": u.uV2=filmicCurve(11.2); break;
    case "reinhard": u.uV2=hableCurve(11.2); break;
    case "wbk": var kg=kelvinGains(op.v); u.uColA=[kg[0],kg[1],kg[2]]; break;
    case "curves": u.uV2=op.v2; u.uV3=op.v3; u.uColA=[op.v4, op.v5, op.v6]; break;
    case "tonemap": u.uV2=filmicCurve(11.2); u.uV3=hableCurve(11.2); break;
    case "mantiuk": u.uColA=[9,0.55,0.45]; break;
    case "drago": u.uColA=[5,0.40,0.60]; break;
    case "hct": case "cam16": u.uColA=HCT_RGBD; u.uFL=HCT_FL; break;
    case "ciecam02": u.uColA=CAM02_RGBD; u.uFL=HCT_FL; break;
    case "huerotok": var rad=op.v*Math.PI/180; u.uV2=Math.cos(rad); u.uV3=Math.sin(rad); break;
  }
  return u;
}
/* Estadísticas globales → uniformes; devuelve null si el filtro no aplica */
function globalUniforms(op){
  var buf=sampleStats(), total=64*64, amt=op.v, key=op.key;
  if(key==="cielch"){
    var maxC=statsMaxChroma(buf);
    var target=(1-amt)*100 + amt*maxC;
    var factor= target>0 ? 100/target : 1;
    if(factor===1) return null;
    return {uV2:factor, uRes:[jobW,jobH]};
  }
  if(key==="autolevels"){
    var hist=statsHist(buf), lo=[0,0,0], hi=[255,255,255];
    for(var c=0;c<3;c++){
      lo[c]=histPercentile(hist[c], total, 0.01);
      hi[c]=histPercentile(hist[c], total, 0.99);
      if(hi[c]<=lo[c]){ lo[c]=0; hi[c]=255; }
    }
    return {uV:amt, uLo:[lo[0]/255,lo[1]/255,lo[2]/255], uHi:[hi[0]/255,hi[1]/255,hi[2]/255], uRes:[jobW,jobH]};
  }
  var gains=null;
  if(key==="awb" || key==="grayworld"){
    var m=statsMean(buf);
    if(m[0]<1/255 || m[1]<1/255 || m[2]<1/255) return null;
    var avg=(m[0]+m[1]+m[2])/3;
    gains=[1+(avg/m[0]-1)*amt, 1+(avg/m[1]-1)*amt, 1+(avg/m[2]-1)*amt];
  }else if(key==="whitepatch"){
    var hist2=statsHist(buf), mm=[0,0,0];
    for(var c2=0;c2<3;c2++) mm[c2]=histPercentile(hist2[c2], total, 0.99)/255;
    if(mm[0]<0.01 || mm[1]<0.01 || mm[2]<0.01) return null;
    gains=[1+(1/mm[0]-1)*amt, 1+(1/mm[1]-1)*amt, 1+(1/mm[2]-1)*amt];
  }else if(key==="shadesgray"){
    var s6=[0,0,0];
    for(var i=0;i<buf.length;i+=4){ for(var c3=0;c3<3;c3++){ var x=buf[i+c3]/255; s6[c3]+=x*x*x*x*x*x; } }
    var m6=[Math.pow(s6[0]/total,1/6), Math.pow(s6[1]/total,1/6), Math.pow(s6[2]/total,1/6)];
    if(m6[0]<0.01 || m6[1]<0.01 || m6[2]<0.01) return null;
    var avg6=(m6[0]+m6[1]+m6[2])/3;
    gains=[1+(avg6/m6[0]-1)*amt, 1+(avg6/m6[1]-1)*amt, 1+(avg6/m6[2]-1)*amt];
  }
  if(!gains) return null;
  return {uGain:gains, uRes:[jobW,jobH]};
}
var GLOBAL_OPS={awb:1, grayworld:1, whitepatch:1, shadesgray:1, autolevels:1, cielch:1};

function applyRetinex(cur, op, w, h){
  var md=Math.min(w,h);
  var radii=[Math.max(2,Math.round(md*0.02)), Math.max(3,Math.round(md*0.10)), Math.max(4,Math.min(60,Math.round(md*0.30)))];
  var b0=blurOf(cur,w,h,radii[0]), b1=blurOf(cur,w,h,radii[1]), b2=blurOf(cur,w,h,radii[2]);
  var useFloat=checkFloat32();
  var raw= useFloat ? acqF(w,h) : acq(w,h);
  var rawProg=getProg("retraw", RETRAW_FRAG); if(!rawProg) throw new Error("retinex shader");
  drawTo(raw, rawProg, {uTex:cur, uBlur:b0, uBlur2:b1, uBlur3:b2}, {uEncode:useFloat?0:1, uRes:[w,h]});
  rel(b0); rel(b1); rel(b2);
  var mn=Infinity, mx=-Infinity;
  var blit=getProg("blit", BLIT_FRAG); if(!blit) throw new Error("blit shader");
  if(useFloat){
    if(!sampleFTex) sampleFTex=makeTex(64,64,true);
    drawTo(sampleFTex, blit, {uTex:raw}, {});
    gl.readPixels(0,0,64,64, gl.RGBA, gl.FLOAT, sampleFBuf);
    for(var i=0;i<sampleFBuf.length;i+=4){
      for(var c=0;c<3;c++){ var fv=sampleFBuf[i+c]; if(isFinite(fv)){ if(fv<mn)mn=fv; if(fv>mx)mx=fv; } }
    }
  }else{
    if(!sampleTex) sampleTex=makeTex(64,64,false);
    drawTo(sampleTex, blit, {uTex:raw}, {});
    gl.readPixels(0,0,64,64, gl.RGBA, gl.UNSIGNED_BYTE, sampleBuf);
    for(var j=0;j<sampleBuf.length;j+=4){
      for(var c2=0;c2<3;c2++){ var rv=(sampleBuf[j+c2]/255-0.5)/0.2; if(rv<mn)mn=rv; if(rv>mx)mx=rv; }
    }
  }
  if(!isFinite(mn) || !isFinite(mx) || mx<=mn){ mn=-1.5; mx=1.5; }
  var combProg=getProg("retcomb", RETCOMB_FRAG); if(!combProg) throw new Error("retinex combine shader");
  var next=acq(w,h);
  drawTo(next, combProg, {uTex:cur, uRaw:raw}, {uV:op.v, uV2:mn, uV3:(mx-mn), uEncode:useFloat?0:1, uRes:[w,h]});
  if(useFloat) relF(raw); else rel(raw);
  rel(cur);
  return next;
}

function applyOpGpu(cur, op, w, h){
  var key=op.key;
  if(key.slice(0,3)==="lut"){
    var lt=getLutTex(parseInt(key.slice(3),10));
    if(!lt) throw new Error("textura LUT float no disponible");
    var prL=getProg("lut", LUT_FRAG); if(!prL) throw new Error("lut shader");
    var nextL=acq(w,h);
    drawTo(nextL, prL, {uTex:cur, uLut:{tex:lt}}, {uV:op.v, uLutN:lt._lutN||33, uRes:[w,h]});
    rel(cur);
    return nextL;
  }
  if(key==="retinex") return applyRetinex(cur, op, w, h);
  if(BLUR_OPS[key]){
    var bl=blurOf(cur, w, h, blurRadius(key, w, h));
    var uniforms={uV:op.v, uRes:[w,h]};
    if(key==="dehaze") uniforms.uColA=statsMean(sampleStats());
    var prB=getProg("b_"+key, pointFrag(BB[key])); if(!prB) throw new Error("blur op shader "+key);
    var nextB=acq(w,h);
    drawTo(nextB, prB, {uTex:cur, uBlur:bl}, uniforms);
    rel(bl); rel(cur);
    return nextB;
  }
  if(GLOBAL_OPS[key]){
    var gu=globalUniforms(op);
    if(!gu) return cur;
    var prG=getProg("p_"+pointProgKey(key), pointFrag(PB[pointProgKey(key)])); if(!prG) throw new Error("global shader "+key);
    var nextG=acq(w,h);
    drawTo(nextG, prG, {uTex:cur}, gu);
    rel(cur);
    return nextG;
  }
  if(key==="tonemap" || key==="sat"){
    var subKey=null, subV=0;
    if(key==="tonemap"){
      var curve=Math.round(op.v);
      if(curve<=0 || op.v2===0) return cur;
      /* AgX (5) faltaba aquí: subKey quedaba undefined, el shader no
         compilaba y toda la tanda caía a CPU con la GPU apagada. */
      subKey=["","reinhard","aces","filmic","scurve","agx"][curve]; subV=op.v2*(TONEMAP_GAIN[curve]||1);
    }else{
      if(op.v2===1) return cur;
      subKey=["oklch","hsluv","hct"][Math.max(0, Math.min(2, Math.round(op.v)))]; subV=op.v2;
    }
    var prS=getProg("p_"+subKey, pointFrag(PB[subKey])); if(!prS) throw new Error("shader "+subKey);
    var nextS=acq(w,h);
    drawTo(nextS, prS, {uTex:cur}, pointUniforms({key:subKey, v:subV, v2:0}, w, h));
    rel(cur);
    return nextS;
  }
  var pk=pointProgKey(key);
  var body=PB[pk];
  if(!body) return cur;
  var pr=getProg("p_"+pk, pointFrag(body)); if(!pr) throw new Error("point shader "+key);
  var binds={uTex:cur};
  if(key==="dither") binds.uBayer=getBayerTex();
  var next=acq(w,h);
  drawTo(next, pr, binds, pointUniforms(op, w, h));
  rel(cur);
  return next;
}

function renderChain(src, w, h, genome){
  /* La cadena de pasadas de render() pero sin leer nada al final: deja
     el resultado en una textura de la GPU y la devuelve. Devuelve null
     si alguna LUT no tiene ruta GPU (ese ítem lo hace la CPU) y lanza
     si la GPU falla, igual que hacía render(). */
  jobW=w; jobH=h;
  var srcTex=uploadSource(src, w, h);
  var cur=srcTex;
  jobCur=cur;
  var ops=buildOps(genome);
  for(var li=0;li<ops.length;li++){
    var lk=ops[li].key;
    if(lk.slice(0,3)==="lut" && !getLutTex(parseInt(lk.slice(3),10))) return null; /* LUT float sin ruta GPU: el render completo cae a CPU */
  }
  for(var i=0;i<ops.length;i++){
    cur=applyOpGpu(cur, ops[i], w, h);
    jobCur=cur;
  }
  if(cur===srcTex){
    /* Genoma sin operaciones: copia para que cada ítem tenga su textura */
    var blit0=getProg("blit", BLIT_FRAG); if(!blit0) throw new Error("blit shader");
    var cp=acq(w,h);
    drawTo(cp, blit0, {uTex:cur}, {});
    cur=cp;
  }
  return cur;
}
function render(src, w, h, genome, targetCtx){
  if(!ensure() || broken) return false;
  if(!w || !h || w>maxTexSize || h>maxTexSize) return false;
  try{
    if(glCanvas.width!==w) glCanvas.width=w;
    if(glCanvas.height!==h) glCanvas.height=h;
    var cur=renderChain(src, w, h, genome);
    if(cur===null) return false;
    var blit=getProg("blit", BLIT_FRAG); if(!blit) throw new Error("blit shader");
    drawTo(null, blit, {uTex:cur}, {});
    targetCtx.drawImage(glCanvas, 0, 0, w, h);
    rel(cur);
    return true;
  }catch(e){
    broken=true;
    if(window.console) console.warn("GPU no disponible, se usa CPU:", e);
    return false;
  }
}
function renderDithered(src, w, h, genome, canvas, dith){
  /* Vistas previas y exportación: como render() pero leyendo la textura final en
     float y cuantizando a 8 bits en CPU con dithering Bayer ordenado:
     a cada píxel se le suma (m+0.5)/n²−0.5 según (x%n, y%n) antes de
     redondear a 0..255. El canal alfa no se toca. Si la cadena NO es
     float (fallback RGBA8) esta ruta devuelve false a propósito: ahí
     los valores ya vienen cuantizados a enteros 0..255 y sumar el
     desplazamiento Bayer (< ½ LSB) después de cuantizar redondearía
     siempre al mismo byte —la imagen saldría idéntica—, así que el
     llamador cae a la cadena CPU float32, que sí aplica el Bayer en
     su única cuantización final. */
  if(!ensure() || broken) return false;
  if(!w || !h || w>maxTexSize || h>maxTexSize) return false;
  try{
    var cur=renderChain(src, w, h, genome);
    if(cur===null) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cur, 0);
    var ts=texSize.get(cur);
    if(ts && ts.f){
      var fbuf=new Float32Array(w*h*4);
      gl.readPixels(0,0,w,h, gl.RGBA, gl.FLOAT, fbuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      var img=new ImageData(w, h), d=img.data, row=w*4;
      if(dith.kind==="ordered"){
        var dn=dith.n, dm=dith.m;
        for(var y=0;y<h;y++){
          var srcOff=(h-1-y)*row, dstOff=y*row, mrow=(y%dn)*dn;
          for(var x=0;x<w;x++){
            var so=srcOff+x*4, dof=dstOff+x*4, t=dm[mrow+(x%dn)]-0.5;
            d[dof]=fbuf[so]*255+t; d[dof+1]=fbuf[so+1]*255+t; d[dof+2]=fbuf[so+2]*255+t; d[dof+3]=fbuf[so+3]*255;
          }
        }
      }else{
        /* FS / híbrido: se voltea el buffer float (readPixels entrega
           la fila inferior primero) a un Float32Array arriba→abajo en
           0..255 y se cuantiza ahí, para que la difusión recorra la
           imagen en su orientación visible. */
        var top=new Float32Array(w*h*4);
        for(var yy=0;yy<h;yy++){
          var sOff=(h-1-yy)*row, dOff=yy*row;
          for(var xx=0;xx<row;xx++) top[dOff+xx]=fbuf[sOff+xx]*255;
        }
        if(dith.kind==="fs") floydSteinbergQuantize(top, w, h, d);
        else hybridQuantize(top, w, h, d, dith.bn);
      }
      canvas.getContext("2d").putImageData(img, 0, 0);
    }else{
      /* Cadena RGBA8: sin float no hay información sub-LSB que
         difuminar; devolver éxito aquí dejaba la descarga sin
         dithering y bloqueaba el fallback CPU con dither. */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      rel(cur);
      return false;
    }
    rel(cur);
    return true;
  }catch(e){
    broken=true;
    if(window.console) console.warn("GPU no disponible, se usa CPU:", e);
    return false;
  }
}
function paintPixels(canvas, buf, w, h){
  /* readPixels entrega la imagen con la fila inferior primero: se
     voltea al pasarla a ImageData (fila superior primero). */
  var img=new ImageData(w, h), d=img.data, row=w*4;
  for(var y=0;y<h;y++){
    var srcOff=(h-1-y)*row, dstOff=y*row;
    for(var x=0;x<row;x++) d[dstOff+x]=buf[srcOff+x];
  }
  canvas.getContext("2d").putImageData(img, 0, 0);
}
function paintPixelsFloat(canvas, fbuf, w, h){
  /* Igual que paintPixels pero desde un buffer FLOAT: la cuantización
     a 0..255 ocurre solo aquí, al volcar el resultado final. */
  var img=new ImageData(w, h), d=img.data, row=w*4;
  for(var y=0;y<h;y++){
    var srcOff=(h-1-y)*row, dstOff=y*row;
    for(var x=0;x<row;x++) d[dstOff+x]=fbuf[srcOff+x]*255;
  }
  canvas.getContext("2d").putImageData(img, 0, 0);
}
function paintPixelsFloatDithered(canvas, fbuf, w, h, dith){
  /* Como paintPixelsFloat, pero la única cuantización float32 → 8 bits
     aplica el dithering vigente: ordenado (umbral m−0.5 según la
     posición final del píxel), Floyd-Steinberg o el híbrido (blue
     noise 512 + Floyd-Steinberg en Oklch). Para FS/híbrido se voltea
     el buffer a arriba→abajo y se cuantiza ahí, para que la difusión
     recorra la imagen en su orientación visible. Alfa intacto. */
  var img=new ImageData(w, h), d=img.data, row=w*4;
  if(dith.kind==="ordered"){
    var dn=dith.n, dm=dith.m;
    for(var y=0;y<h;y++){
      var srcOff=(h-1-y)*row, dstOff=y*row, mrow=(y%dn)*dn;
      for(var x=0;x<w;x++){
        var so=srcOff+x*4, dof=dstOff+x*4, t=dm[mrow+(x%dn)]-0.5;
        d[dof]=fbuf[so]*255+t; d[dof+1]=fbuf[so+1]*255+t; d[dof+2]=fbuf[so+2]*255+t; d[dof+3]=fbuf[so+3]*255;
      }
    }
  }else{
    var top=new Float32Array(w*h*4);
    for(var yy=0;yy<h;yy++){
      var sOff=(h-1-yy)*row, dOff=yy*row;
      for(var xx=0;xx<row;xx++) top[dOff+xx]=fbuf[sOff+xx]*255;
    }
    if(dith.kind==="fs") floydSteinbergQuantize(top, w, h, d);
    else hybridQuantize(top, w, h, d, dith.bn);
  }
  canvas.getContext("2d").putImageData(img, 0, 0);
}
function readTexToCanvas(tex, w, h, canvas, dith){
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  var ts=texSize.get(tex);
  if(ts && ts.f){
    var fbuf=new Float32Array(w*h*4);
    gl.readPixels(0,0,w,h, gl.RGBA, gl.FLOAT, fbuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if(dith) paintPixelsFloatDithered(canvas, fbuf, w, h, dith);
    else paintPixelsFloat(canvas, fbuf, w, h);
    return true;
  }
  /* Con dithering pedido y cadena RGBA8 no hay información sub-LSB que
     difuminar: se devuelve false para que el llamador rehaga el ítem
     por la cadena CPU float32, igual que en renderDithered. */
  if(dith){ gl.bindFramebuffer(gl.FRAMEBUFFER, null); return false; }
  var buf=new Uint8Array(w*h*4);
  gl.readPixels(0,0,w,h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  paintPixels(canvas, buf, w, h);
  return true;
}
function renderBatchAsync(src, w, h, items, onItem, onAll, dith){
  /* GPU en paralelo / sin bloqueos (solo en este clon): un solo
     contexto WebGL2 para todo. Primero se ENCOLAN las cadenas de las
     variantes, cada una en su textura, sin leer ningún resultado:
     mientras la CPU encola la siguiente, la GPU ya está trabajando
     en las anteriores en vez de esperar ociosamente a cada lectura.
     Después se leen todas las texturas con lectura asíncrona
     (PIXEL_PACK_BUFFER + fenceSync, sondeados sin bloquear el hilo
     principal) y cada resultado se compone en su canvas.
     onItem(item, true) por cada variante terminada en GPU;
     onItem(item, false) si esa variante no tiene ruta GPU (LUT sin
     float lineal) y debe hacerla la CPU. Devuelve false si el lote
     no pudo arrancar: el llamador degrada todo a CPU. */
  if(!ensure() || broken) return false;
  if(!w || !h || w>maxTexSize || h>maxTexSize) return false;
  var pending=[], i, it, tex;
  try{
    for(i=0;i<items.length;i++){
      it=items[i];
      tex=renderChain(src, w, h, it.genome);
      if(tex===null){ onItem(it, false); continue; }
      pending.push({item:it, tex:tex});
    }
  }catch(e){
    broken=true;
    if(window.console) console.warn("GPU no disponible, se usa CPU:", e);
    for(i=0;i<pending.length;i++) rel(pending[i].tex);
    return false;
  }
  if(!pending.length){ if(onAll) onAll(); return true; }
  /* Fase de lectura asíncrona: un PBO y una fence por textura */
  var jobs=[], pboOk=true;
  try{
    for(i=0;i<pending.length;i++){
      var p=pending[i];
      var pbo=gl.createBuffer();
      if(!pbo) throw new Error("pbo");
      var pts=texSize.get(p.tex), isF=!!(pts && pts.f);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, isF? w*h*16 : w*h*4, gl.STREAM_READ);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, p.tex, 0);
      gl.readPixels(0,0,w,h, gl.RGBA, isF? gl.FLOAT : gl.UNSIGNED_BYTE, 0); /* al PBO: vuelve enseguida */
      var fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if(!fence) throw new Error("fence");
      jobs.push({item:p.item, tex:p.tex, pbo:pbo, fence:fence, done:false, isF:isF});
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.flush();
  }catch(e){ pboOk=false; }
  if(!pboOk){
    /* Sin PBO/fence viables: lectura directa al final. Las cadenas ya
       están todas encoladas, así que aun así no se bloquea entre renders. */
    try{
      for(i=0;i<jobs.length;i++){
        try{ gl.deleteSync(jobs[i].fence); }catch(e){}
        try{ gl.deleteBuffer(jobs[i].pbo); }catch(e){}
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      for(i=0;i<pending.length;i++){
        var paintedDirect=readTexToCanvas(pending[i].tex, w, h, pending[i].item.canvas, dith);
        rel(pending[i].tex);
        onItem(pending[i].item, paintedDirect);
      }
    }catch(e2){
      for(i=0;i<pending.length;i++) rel(pending[i].tex);
      return false;
    }
    if(onAll) onAll();
    return true;
  }
  var remaining=jobs.length, frames=0;
  function finishJob(jb, okItem){
    jb.done=true; remaining--;
    try{ gl.deleteSync(jb.fence); }catch(e){}
    try{ gl.deleteBuffer(jb.pbo); }catch(e){}
    rel(jb.tex);
    onItem(jb.item, okItem);
  }
  function readJob(jb){
    if(jb.isF){
      var fbuf=new Float32Array(w*h*4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, jb.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, fbuf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      if(dith) paintPixelsFloatDithered(jb.item.canvas, fbuf, w, h, dith);
      else paintPixelsFloat(jb.item.canvas, fbuf, w, h);
      return true;
    }
    /* Con dithering y cadena RGBA8: sin pintar; el llamador rehace el
       ítem por CPU float32, donde el Bayer sí entra en la cuantización. */
    if(dith) return false;
    var buf=new Uint8Array(w*h*4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, jb.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    paintPixels(jb.item.canvas, buf, w, h);
    return true;
  }
  function poll(){
    var progressed=true;
    while(progressed){
      progressed=false;
      for(var j=0;j<jobs.length;j++){
        var jb=jobs[j];
        if(jb.done) continue;
        var st;
        try{ st=gl.clientWaitSync(jb.fence, 0, 0); }catch(e){ st=gl.WAIT_FAILED; }
        if(st===gl.ALREADY_SIGNALED || st===gl.CONDITION_SATISFIED){
          progressed=true;
          try{ finishJob(jb, readJob(jb)!==false); }
          catch(e){ finishJob(jb, false); }
        }else if(st===gl.WAIT_FAILED){
          finishJob(jb, false);
        }
      }
    }
    if(remaining<=0){ if(onAll) onAll(); return; }
    frames++;
    if(frames>600){
      /* La GPU no señalizó a tiempo: se lee lo que queda para no dejar la rejilla a medias */
      for(var j2=0;j2<jobs.length;j2++){
        var jx=jobs[j2];
        if(jx.done) continue;
        try{ finishJob(jx, readJob(jx)!==false); }
        catch(e){ finishJob(jx, false); }
      }
      if(onAll) onAll();
      return;
    }
    if(typeof requestAnimationFrame==="function") requestAnimationFrame(poll);
    else setTimeout(poll, 16);
  }
  if(typeof requestAnimationFrame==="function") requestAnimationFrame(poll);
  else setTimeout(poll, 0);
  return true;
}
function warmup(){
  if(!ensure() || broken) return;
  try{
    for(var k in PB) getProg("p_"+k, pointFrag(PB[k]));
    for(var k2 in BB) getProg("b_"+k2, pointFrag(BB[k2]));
    getProg("blit", BLIT_FRAG); getProg("blurpass", BLUR_FRAG);
    getProg("lut", LUT_FRAG); getProg("retraw", RETRAW_FRAG); getProg("retcomb", RETCOMB_FRAG);
  }catch(e){ /* la compilación real se reintenta al renderizar */ }
}
return { ensure:ensure, ok:ok, render:render, renderDithered:renderDithered, renderBatchAsync:renderBatchAsync, warmup:warmup, invalidateSources:invalidateSources, invalidateLut:invalidateLut };
})();

/* ---------- utilidades genéticas ---------- */
function clampVal(f,v){ return Math.max(f.min, Math.min(f.max, v)); }
function randIn(f){ return f.min + Math.random()*(f.max-f.min); }
function gauss(){ return (Math.random()+Math.random()+Math.random())/1.5 - 1; } // -1..1
function shuffled(arr){
  var a=arr.slice();
  for(var i=a.length-1;i>0;i--){ var j=(Math.random()*(i+1))|0; var t=a[i]; a[i]=a[j]; a[j]=t; }
  return a;
}
function identityGenome(){
  var values={}; GENES.forEach(function(g){ values[g.gkey]=g.def; });
  return { values:values, order:CANON.slice(), kind:"original", lineage:"Sin cambios" };
}
function cloneGenome(g, kind, lineage){
  var values={}; GENES.forEach(function(gn){ values[gn.gkey]=g.values[gn.gkey]; });
  return { values:values, order:g.order.slice(), kind:kind||g.kind, lineage:lineage||g.lineage };
}
/* Variante del ancestro: mezcla de conservar, desplazar y reinventar genes + orden barajado */
/* Genes permitidos: tras la fase de elegir genes, solo las LUTs marcadas
   por el usuario pueden aparecer en la evolución. allowedSet es null
   hasta que esa fase se confirma (sin restricción). */
var allowedSet=null;
function isAllowedKey(key){ return !allowedSet || !!allowedSet[key]; }
function allowedFilters(){ return FILTERS.filter(function(f){ return isAllowedKey(f.key); }); }
function mutantOf(base, spread){
  var values={};
  GENES.forEach(function(f){
    if(!isAllowedKey(f.gkey)){ values[f.gkey]=base.values[f.gkey]; return; }
    var r=Math.random();
    if(r<0.30){ values[f.gkey]=base.values[f.gkey]; }
    else if(r<0.82){ values[f.gkey]=clampVal(f, base.values[f.gkey] + gauss()*spread*(f.max-f.min)); }
    else { values[f.gkey]=randIn(f); }
  });
  return { values:values, order:fixOrder(shuffled(CANON)), kind:"mutante", lineage:"Mutante" };
}
function randomGenome(){
  /* Inmigrante LUT: solo unas pocas LUTs activas (2 a 6), no decenas apiladas. */
  var values={};
  GENES.forEach(function(f){ values[f.gkey]=f.def; });
  var pool=shuffled(allowedFilters()), k=Math.min(pool.length, 2+((Math.random()*5)|0));
  for(var i=0;i<k && i<pool.length;i++){ var pf=pool[i]; values[pf.key]= pf.key.slice(0,3)==="lut" ? 0.15+0.85*Math.random() : randIn(pf); }
  return { values:values, order:fixOrder(shuffled(CANON)), kind:"inmigrante", lineage:"Nuevo" };
}
/* Primera generación con rutas: se usa SOLO al nacer la población (la
   mutación y la evolución posteriores no cambian). Antes cada variante
   activaba pocos genes cerca del valor por defecto y casi nunca tocaba
   los pasos fijos, así que la Gen 0 salía casi idéntica al original.
   Ahora cada variante toca 1-2 pasos fijos del pipeline (exposición,
   balance de blancos, curvas, tone mapping o saturación) con
   desplazamientos grandes, el operador de tone mapping se sortea en
   todo su rango 0-5 (antes solo salían Lineal/Reinhard, AgX era
   inalcanzable) y el modelo de saturación en 0-2; las LUT llegan hasta
   0.95 de potencia. Los Límites seguros siguen filtrando: lo que se
   pasa se rechaza o se repara, así que las rutas que quedan son
   diversas pero viables. */
function softInitialGenome(base, idx){
  var values={};
  GENES.forEach(function(f){ values[f.gkey]=base.values[f.gkey]; });
  var tier;
  if(idx<7) tier=1; /* ni las primeras son copias: también muestran rutas */
  else { var rt=Math.random(); tier= rt<0.25?1 : rt<0.75?2 : 3; }
  var minGenes= tier===1?2 : tier===2?3 : 4;
  var maxGenes= tier===1?4 : tier===2?6 : 9;
  var k=minGenes+((Math.random()*(maxGenes-minGenes+1))|0);
  var frac= tier===1?0.20 : tier===2?0.35 : 0.55;   /* desplazamiento máx. desde el valor por defecto, como fracción del rango */
  var lutCap= tier===1?0.55 : tier===2?0.75 : 0.95; /* intensidad máx. de una LUT en esta generación */
  var lutLimit= 99; /* solo hay LUTs: se pueden apilar hasta k en la variante inicial */
  var pool=shuffled(allowedFilters()), chosen=[], lutsUsed=0;
  for(var i=0;i<pool.length && chosen.length<k;i++){
    var f=pool[i], isLut=f.key.slice(0,3)==="lut";
    if(isLut && lutsUsed>=lutLimit) continue;
    chosen.push(f); if(isLut) lutsUsed++;
  }
  /* Rutas: que cada variante toque al menos 1-2 pasos fijos del
     pipeline (Hue queda fuera: nace fijado en 0, 0 por pin global). */
  var forcedN= tier===1?1 : 2, forcedCount=0;
  var fixedPool=shuffled(["exp","wbk","dehaze","retinex","curves","clarity","tonemap","loclap","guided","sat"]);
  for(var fi=0; fi<fixedPool.length && forcedCount<forcedN; fi++){
    var fk=fixedPool[fi], ff=FBY[fk];
    if(!ff) continue;
    var already=false;
    for(var ci=0; ci<chosen.length; ci++){ if(chosen[ci].key===fk){ already=true; break; } }
    if(already) continue;
    chosen.push(ff); forcedCount++;
  }
  chosen.forEach(function(f){
    if(f.key.slice(0,3)==="lut"){
      values[f.key]=(0.30+0.70*Math.random())*lutCap;
    }else if(f.key==="tonemap"){
      /* Operador sorteado en todo el rango 0-5: así AgX sí aparece en
         Gen 0, con su intensidad (sub-gen) sorteada en 0-1. */
      values[f.key]=(Math.random()*6)|0;
    }else if(f.key==="sat"){
      values[f.key]=(Math.random()*3)|0; /* modelo OKLCh / HSLuv / CAM16-UCS */
    }else{
      var range=f.max-f.min, mag=(0.35+0.65*Math.random())*frac*range, off;
      if(f.def<=f.min) off=mag;
      else if(f.def>=f.max) off=-mag;
      else off=(Math.random()<0.5?-mag:mag);
      var nv=clampVal(f, f.def+off);
      if(nv===f.def) nv=clampVal(f, f.def-off);
      values[f.key]=nv;
    }
    subGenesOf(f).forEach(function(sg){ values[sg.gkey]= sg.min + Math.random()*(sg.max-sg.min); });
  });
  return applyGenePins({ values:values, order:fixOrder(shuffled(CANON)), kind:"suave", lineage:"Inicial suave" }); /* los pins globales mandan también al nacer: con el pin por defecto, Hue sale en 0, 0 */
}
/* Cruce de orden OX: conserva un tramo de A y rellena con el orden de B */
function orderCrossover(a, b){
  var n=a.length, i=(Math.random()*n)|0, j=(Math.random()*n)|0;
  if(i>j){ var t=i; i=j; j=t; }
  var child=new Array(n), used={};
  for(var k=i;k<=j;k++){ child[k]=a[k]; used[a[k]]=true; }
  var pos=0;
  for(var m=0;m<n;m++){
    if(used[b[m]]) continue;
    while(pos>=i && pos<=j) pos++;
    child[pos]=b[m]; pos++;
  }
  return fixOrder(child);
}
function crossover(a, b){
  var values={};
  GENES.forEach(function(f){ values[f.gkey]= Math.random()<0.5 ? a.values[f.gkey] : b.values[f.gkey]; });
  return { values:values, order:orderCrossover(a.order, b.order), kind:"hijo", lineage:"" };
}
function mutate(g, rate){
  var muts=0;
  GENES.forEach(function(f){
    if(!isAllowedKey(f.gkey)) return;
    if(genePins[f.gkey]!==undefined) return; /* gen fijado por pin global: la mutación no lo toca */
    if(Math.random()<rate){
      if(Math.random()<0.25){ g.values[f.gkey]=randIn(f); }
      else { g.values[f.gkey]=clampVal(f, g.values[f.gkey] + gauss()*0.30*(f.max-f.min)); }
      muts++;
    }
  });
  if(Math.random()<rate*1.6){
    var swaps=1+((Math.random()*2)|0);
    for(var s=0;s<swaps;s++){
      /* Solo se baraja la zona de LUTs, tras los pasos 1-11. */
      var hb=FIXED_HEAD.length, span=g.order.length-hb;
      if(span<2) break;
      var i=hb+((Math.random()*span)|0), j=hb+((Math.random()*span)|0);
      var t=g.order[i]; g.order[i]=g.order[j]; g.order[j]=t; muts++;
    }
  }
  return muts;
}

/* ==================================================================
   Estado e interfaz
   ================================================================== */
var gridEl=document.getElementById("grid"), gridZone=document.getElementById("gridZone"),
    statusEl=document.getElementById("status")||{textContent:""}, toastEl=document.getElementById("toast"),
    genBadge=document.getElementById("genBadge"), selCountEl=document.getElementById("selCount")||{textContent:""},
    btnEvolve=document.getElementById("btnEvolve"), progressEl=document.getElementById("progress"),
    progressBar=document.getElementById("progressBar"), fileInput=document.getElementById("fileInput"),
    sMut=document.getElementById("sMut"), vMut=document.getElementById("vMut"),
    sDecay=document.getElementById("sDecay"), vDecay=document.getElementById("vDecay"),
    sGridSize=document.getElementById("sGridSize"), vGridSize=document.getElementById("vGridSize"),
    gridLegendText=document.getElementById("gridLegendText")||{textContent:"",innerHTML:""},
    previewCanvas=document.getElementById("previewCanvas"), previewFrame=document.getElementById("previewFrame"),
    previewTitle=document.getElementById("previewTitle")||{textContent:""}, previewHint=document.getElementById("previewHint")||{textContent:""},
    previewTag=document.getElementById("previewTag")||{textContent:""},
    beforeCanvas=document.getElementById("beforeCanvas");

var source=null, sW=0, sH=0, sName="imagen", isDemo=false;
var workCanvas=document.createElement("canvas"); // copia de trabajo a tamaño miniatura
var TW=0, TH=0;
var geneWork=document.createElement("canvas"); // copia mayor solo para la fase de genes: se ve en 2-3 columnas y necesita nitidez real
var GW=0, GH=0;
var previewWork=document.createElement("canvas"); // copia mayor para el panel de la derecha
var PW=0, PH=0;
var previewClean=document.createElement("canvas"); // la variante en vista previa SIN dithering: solo la lee el panel Diferencia
var population=[], generation=0, selected={}, detailCell=-1, rendering=false, toastTimer=null;
var previewCell=CENTER_CELL, pinnedCell=CENTER_CELL, previewTimer=null, previewToken=0;
var pendingOrder=null; // orden cargado desde una imagen, para el próximo ancestro
/* Pins globales de genes (candado en Transformaciones): gkey → valor
   fijado. Valen para TODOS los hijos de las siguientes generaciones, sin
   importar de qué variante desciendan: tras cruce y mutación se fuerzan
   con applyGenePins, y la mutación y el pulido del árbol los respetan.
   Son de la sesión: se limpian al cargar una imagen nueva / crear Gen 0,
   salvo el pin por defecto de «Hue / Color selectivo», que siempre nace
   fijado en 0, 0 (Hue objetivo 0° y Desplazamiento 0°, los valores por
   defecto del gen) y el usuario puede soltar con su candado en
   Transformaciones como cualquier otro pin. */
var genePins={};
function applyGenePins(g){ for(var k in genePins) g.values[k]=genePins[k]; return g; }
function defaultHuePin(){
  var pins={}, f=FBY["huesel"];
  if(f){ pins[f.key]=f.def; subGenesOf(f).forEach(function(sg){ pins[sg.gkey]=sg.def; }); }
  return pins;
}
function resetGenePins(){ genePins=defaultHuePin(); }
resetGenePins();

function showToast(m){ toastEl.textContent=m; toastEl.classList.add("show"); if(toastTimer)clearTimeout(toastTimer); toastTimer=setTimeout(function(){toastEl.classList.remove("show")},3200); }
/* Mutación y decaimiento: la ÚNICA fuente de verdad son estas dos variables.
   Los sliders solo las reflejan; ningún render, carga de imagen ni selección
   las toca. El bug anterior leía y reescribía el propio slider de Mutación
   desde rutas que corrían varias veces por generación, así que el descuento
   se componía y la mutación se desplomaba (32 → 5 → 2 → 0). Ahora el
   descuento vive en applyDecayOnce() y solo se llama una vez, desde el
   clic en Evolucionar. */
var mutationPct=32, decayPct=2, decayAppliedForGen=-1;
function syncMutUI(){
  var t=String(mutationPct);
  if(sMut && sMut.value!==t) sMut.value=t;
  if(vMut) vMut.textContent=mutationPct+"%";
}
function syncDecayUI(){
  var t=String(decayPct);
  if(sDecay && sDecay.value!==t) sDecay.value=t;
  if(vDecay) vDecay.textContent=decayPct+"%";
}
function mutRate(){ return mutationPct/100; }
if(sMut) sMut.addEventListener("input", function(){
  var n=parseInt(sMut.value,10);
  mutationPct= isFinite(n) ? Math.max(0, Math.min(60, n)) : mutationPct;
  if(vMut) vMut.textContent=mutationPct+"%";
});
if(sDecay) sDecay.addEventListener("input", function(){
  var n=parseInt(sDecay.value,10);
  decayPct= isFinite(n) ? Math.max(0, Math.min(10, n)) : decayPct;
  if(vDecay) vDecay.textContent=decayPct+"%";
});
/* Baja la mutación exactamente decayPct puntos, una sola vez por generación.
   El candado por número de generación impide un segundo descuento dentro de
   la misma generación aunque esta función se invocara de más. */
function applyDecayOnce(forGen){
  if(decayAppliedForGen===forGen) return;
  decayAppliedForGen=forGen;
  mutationPct=Math.max(0, mutationPct-decayPct);
  syncMutUI();
}
syncMutUI(); syncDecayUI();

/* ---------- Ancestro (valores por defecto; ya no hay panel de sliders) ---------- */
var ancestorValues={};
GENES.forEach(function(f){ ancestorValues[f.gkey]=f.def; });
function ancestorGenome(){
  var values={};
  GENES.forEach(function(f){ values[f.gkey]=ancestorValues[f.gkey]; });
  return { values:values, order:fixOrder((pendingOrder||CANON).slice()), kind:"ancestro", lineage:"Base" };
}
function setSlidersFromGenome(g){
  GENES.forEach(function(f){ ancestorValues[f.gkey]=(g.values[f.gkey]!==undefined? g.values[f.gkey] : f.def); });
  pendingOrder=g.order.slice();
}

/* ---------- Retícula ---------- */
var cellEls=[];
function buildGrid(){
  gridEl.innerHTML=""; cellEls=[];
  gridEl.style.setProperty("--ar", TW+" / "+TH);
  gridEl.style.gridTemplateColumns="repeat("+GRID_SIZE+", 1fr)";
  gridEl.setAttribute("data-size", GRID_SIZE);
  gridEl.setAttribute("aria-label", "Variantes en rejilla de "+GRID_SIZE+" por "+GRID_SIZE);
  previewCell=CENTER_CELL; pinnedCell=CENTER_CELL;
  if(previewFrame) previewFrame.style.aspectRatio=TW+" / "+TH;
  if(previewCanvas){ previewCanvas.style.aspectRatio=TW+" / "+TH; }
  for(var c=0;c<GRID_SIZE*GRID_SIZE;c++){
    (function(cellIdx){
      var b=document.createElement("button");
      b.type="button"; b.className="cell"+(cellIdx===CENTER_CELL?" is-center":"");
      b.setAttribute("aria-pressed","false");
      b.style.aspectRatio=TW+" / "+TH;
      var cv=document.createElement("canvas"); cv.width=TW; cv.height=TH;
      b.appendChild(cv);
      var himg=document.createElement("img"); himg.className="hdr-thumb"; himg.alt=""; himg.hidden=true;
      b.appendChild(himg);
      if(cellIdx===CENTER_CELL){
        var tag=document.createElement("span"); tag.className="orig-tag"; tag.textContent="ORIGINAL";
        b.appendChild(tag);
        b.setAttribute("aria-label","Original. Toca para elegir.");
      }else{
        var popIdx=cellIdx<CENTER_CELL?cellIdx:cellIdx-1;
        var num=document.createElement("span"); num.className="num"; num.textContent="#"+(popIdx+1);
        b.appendChild(num);
        b.setAttribute("aria-label","#"+(popIdx+1)+". Toca para elegir.");
      }
      var chk=document.createElement("span"); chk.className="check";
      chk.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      b.appendChild(chk);
      if(cellIdx!==CENTER_CELL){
        var ptag=document.createElement("span"); ptag.className="punish-tag"; ptag.textContent="CASTIGADA";
        b.appendChild(ptag);
      }
      b.addEventListener("click", function(){ onCellClick(cellIdx); });
      b.addEventListener("contextmenu", function(ev){
        if(cellIdx===CENTER_CELL || rendering || !source) return;
        ev.preventDefault();
        showPreview(cellIdx,false);
        if(typeof showPunishMenu==="function") showPunishMenu(cellIdx, ev.clientX, ev.clientY);
      });
      b.addEventListener("mouseenter", function(){ showPreview(cellIdx,false); });
      b.addEventListener("focus", function(){ showPreview(cellIdx,false); });
      gridEl.appendChild(b);
      cellEls.push(b);
    })(c);
  }
  gridEl.onmouseleave=function(){ if(previewCell!==pinnedCell) showPreview(pinnedCell,false); };
}
function genomeAtCell(cellIdx){
  if(cellIdx===CENTER_CELL) return identityGenome();
  var popIdx=cellIdx<CENTER_CELL?cellIdx:cellIdx-1;
  return population[popIdx]||null;
}
/* ---------- Tamaño de la rejilla: slider discreto 3 / 5 / 7 / 9 ---------- */
function updateGridSizeUI(){
  var t=GRID_SIZE+"×"+GRID_SIZE;
  if(vGridSize) vGridSize.innerHTML="Rejilla <b>"+t+"</b>";
  if(gridLegendText) gridLegendText.innerHTML="Rejilla <b>"+t+"</b>: "+POP_SIZE+" variantes.";
  var eg=document.getElementById("emptyGridLabel"); if(eg) eg.textContent=t;
  if(sGridSize && parseInt(sGridSize.value,10)!==GRID_SIZE) sGridSize.value=GRID_SIZE;
}
/* Al cambiar el tamaño, la rejilla se regenera a ese tamaño con el original
   en la nueva celda central. Las variantes nuevas nacen suaves (como la
   primera generación) a partir del genoma seleccionado: el fijado en la
   vista previa; si es el original, el primer genoma marcado; si no hay
   ninguno, el ancestro. La generación actual no se reinicia. */
function setGridSize(n){
  n=parseInt(n,10);
  if(GRID_SIZES.indexOf(n)<0) return;
  if(n===GRID_SIZE){ updateGridSizeUI(); return; }
  if(rendering){ updateGridSizeUI(); return; } /* no tocar la rejilla a mitad de render */
  var base=null;
  if(source){
    if(pinnedCell!==CENTER_CELL) base=genomeAtCell(pinnedCell);
    if(!base){
      var keys=Object.keys(selected);
      for(var ki=0;ki<keys.length;ki++){
        var ci=parseInt(keys[ki],10);
        if(ci!==CENTER_CELL){ base=genomeAtCell(ci); if(base) break; }
      }
    }
    if(!base) base=ancestorGenome();
  }
  applyGridSize(n);
  updateGridSizeUI();
  if(!source || !TW || !TH) return; /* sin imagen: el tamaño se aplica al cargar */
  buildGrid();
  population=[ cloneGenome(base) ];
  for(var gi=1;gi<POP_SIZE;gi++) population.push(softInitialGenome(base, gi));
  population=shuffled(population);
  selected={}; detailCell=-1; pinnedCell=CENTER_CELL; previewCell=CENTER_CELL;
  cellEls.forEach(function(el){ el.setAttribute("aria-pressed","false"); });
  syncSelectionUI();
  renderPopulation();
  showToast("Rejilla "+GRID_SIZE+"×"+GRID_SIZE+": "+POP_SIZE+" variantes + original.");
}
if(sGridSize){
  /* La etiqueta sigue al arrastre; la regeneración (cara) va al soltar («change»). */
  sGridSize.addEventListener("input", function(){
    var n=parseInt(sGridSize.value,10);
    if(vGridSize) vGridSize.innerHTML="Rejilla <b>"+n+"×"+n+"</b>";
  });
  sGridSize.addEventListener("change", function(){ setGridSize(sGridSize.value); });
}
/* Etiqueta, slider y leyenda arrancan con el tamaño por defecto según
   la pantalla (3×3 celular · 5×5 PC), no con el fijo del HTML. */
updateGridSizeUI();
/* ---------- Comparativa antes / después en la columna de la imagen ---------- */
function setSplit(pct){
  pct=Math.max(0, Math.min(100, pct));
  if(previewFrame) previewFrame.style.setProperty("--split", pct+"%");
}
function drawBefore(){
  if(!beforeCanvas || !previewWork.width || !PW || !PH) return;
  if(beforeCanvas.width!==PW || beforeCanvas.height!==PH){ beforeCanvas.width=PW; beforeCanvas.height=PH; }
  var bctx=beforeCanvas.getContext("2d");
  bctx.imageSmoothingEnabled=true; bctx.imageSmoothingQuality="high";
  bctx.drawImage(previewWork,0,0);
}
if(previewFrame){
  var baDragging=false;
  var baFromEvent=function(e){
    var r=previewFrame.getBoundingClientRect();
    if(!r.width) return;
    setSplit((e.clientX-r.left)/r.width*100);
  };
  previewFrame.addEventListener("pointerdown", function(e){ baDragging=true; try{ previewFrame.setPointerCapture(e.pointerId); }catch(err){} baFromEvent(e); });
  previewFrame.addEventListener("pointermove", function(e){ if(baDragging) baFromEvent(e); });
  previewFrame.addEventListener("pointerup", function(){ baDragging=false; });
  previewFrame.addEventListener("pointercancel", function(){ baDragging=false; });
}
/* ---------- Vista previa en la columna derecha ---------- */
/* Copia limpia (sin dithering) de la variante en vista previa, al mismo
   tamaño PW×PH. El panel Diferencia compara ESTA versión contra la
   original: si comparara la vista previa con dithering, el ruido ±1 del
   Bayer encendería el mapa entero y el % de coincidencia bajaría aunque
   el grado fuera el mismo. */
function syncCleanPreview(){
  if(!previewClean || !previewCanvas || !PW || !PH) return;
  if(previewClean.width!==PW || previewClean.height!==PH){ previewClean.width=PW; previewClean.height=PH; }
  var cctx=previewClean.getContext("2d");
  cctx.imageSmoothingEnabled=true; cctx.imageSmoothingQuality="high";
  cctx.drawImage(previewCanvas,0,0,PW,PH);
}
function renderCleanPreview(g){
  if(!previewClean || !previewWork.width || !PW || !PH) return;
  if(previewClean.width!==PW || previewClean.height!==PH){ previewClean.width=PW; previewClean.height=PH; }
  var cctx=previewClean.getContext("2d");
  cctx.imageSmoothingEnabled=true; cctx.imageSmoothingQuality="high";
  if(GPU.render(previewWork, PW, PH, g, cctx)) return;
  cctx.drawImage(previewWork,0,0,PW,PH);
  try{
    var cd=cctx.getImageData(0,0,PW,PH);
    processGenome(cd, g, null);
    cctx.putImageData(cd,0,0);
  }catch(e){ /* queda la copia sin graduar */ }
}
/* Render en alta resolución: parte siempre de previewWork (original a la
   resolución real del panel, ver prepareWork) y aplica el genoma ahí,
   por la cadena float32, con el dithering vigente aplicado en la única
   cuantización final cuando está activado (se ve en tiempo real).
   Nunca se deja como imagen final la miniatura ampliada. El lado ANTES
   y la celda ORIGINAL nunca llevan dithering: son la imagen original,
   ya de 8 bits, que el Bayer no puede cambiar. */
function renderPreviewHiRes(cellIdx, token){
  if(token!==previewToken || previewCell!==cellIdx || !previewWork.width || !PW || !PH) return false;
  /* Si a esta variante le falta alguna rejilla 65³, se pide ahora y la
     vista previa se re-renderiza al llegar; mientras tanto se muestra
     la versión 33³, sin bloquear. */
  if(cellIdx!==CENTER_CELL && !(typeof genePhase!=="undefined" && genePhase)){
    var pg=genomeAtCell(cellIdx), pmiss=false;
    if(pg && !pg._lut65Kicked){ try{ activeLutsOf(pg).forEach(function(a){ if(!hasLut65(a.id)) pmiss=true; }); }catch(e){} }
    if(pmiss){ pg._lut65Kicked=true; ensure65ForGenome(pg, function(){ renderPreviewHiRes(cellIdx, token); }); }
  }
  try{
    if(previewCanvas.width!==PW||previewCanvas.height!==PH){ previewCanvas.width=PW; previewCanvas.height=PH; }
    var ctx=previewCanvas.getContext("2d");
    ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high";
    if(cellIdx===CENTER_CELL){
      ctx.drawImage(previewWork,0,0,PW,PH);
      syncCleanPreview();
      drawBefore();
      scheduleScopesUpdate();
      return true;
    }
    var g=genomeAtCell(cellIdx);
    if(!g) return false;
    var dith=currentDither();
    if(dith){
      if(GPU.renderDithered(previewWork, PW, PH, g, previewCanvas, dith)){
        if(token!==previewToken || previewCell!==cellIdx) return false;
        renderCleanPreview(g);
        drawBefore();
        scheduleScopesUpdate();
        return true;
      }
      /* Sin cadena GPU float: CPU float32, que sí aplica el Bayer en su
         única cuantización. La versión limpia va a previewClean. */
      renderCleanPreview(g);
      ctx.drawImage(previewWork,0,0,PW,PH);
      var ddata=ctx.getImageData(0,0,PW,PH);
      processGenome(ddata, g, dith);
      if(token!==previewToken || previewCell!==cellIdx) return false;
      ctx.putImageData(ddata,0,0);
      drawBefore();
      scheduleScopesUpdate();
      return true;
    }
    if(GPU.render(previewWork, PW, PH, g, ctx)){
      if(token!==previewToken || previewCell!==cellIdx) return false;
      syncCleanPreview();
      drawBefore();
      scheduleScopesUpdate();
      return true;
    }
    ctx.drawImage(previewWork,0,0,PW,PH);
    var data=ctx.getImageData(0,0,PW,PH);
    processGenome(data, g);
    if(token!==previewToken || previewCell!==cellIdx) return false;
    ctx.putImageData(data,0,0);
    syncCleanPreview();
    drawBefore();
    scheduleScopesUpdate();
    return true;
  }catch(e){ return false; }
}
function showPreview(cellIdx, pin){
  if(!source || !previewCanvas || !cellEls[cellIdx]) return;
  if(pin) pinnedCell=cellIdx;
  previewCell=cellIdx;
  cellEls.forEach(function(el,i){ el.classList.toggle("is-previewing", i===cellIdx); });
  var isCenter=cellIdx===CENTER_CELL;
  var popIdx=cellIdx<CENTER_CELL?cellIdx:cellIdx-1;
  previewTitle.textContent= isCenter ? "Original" : "#"+(popIdx+1);
  previewHint.textContent= isCenter ? "Sin LUTs" : (pin||pinnedCell===cellIdx ? "Fijada" : "");
  previewTag.textContent= isCenter ? "ORIGINAL" : "";
  showDetail(cellIdx);
  var token=++previewToken;
  if(previewTimer) clearTimeout(previewTimer);
  if(pin || isCenter){
    // Click (fijar) u original: alta resolución inmediata, sin espera.
    if(renderPreviewHiRes(cellIdx, token)) return;
  }
  // Hover: placeholder instantáneo con la miniatura y refinado enseguida.
  if(PW>0 && PH>0){
    if(previewCanvas.width!==PW||previewCanvas.height!==PH){ previewCanvas.width=PW; previewCanvas.height=PH; }
    var pctx=previewCanvas.getContext("2d");
    pctx.imageSmoothingEnabled=true; pctx.imageSmoothingQuality="high";
    var thumb=cellEls[cellIdx].querySelector("canvas");
    if(thumb) pctx.drawImage(thumb,0,0,PW,PH);
    drawBefore();
  }
  previewTimer=setTimeout(function(){ renderPreviewHiRes(cellIdx, token); }, 40);
  if(typeof scheduleHdrPreview==="function") scheduleHdrPreview();
}
function onCellClick(cellIdx){
  if(rendering) return;
  /* Una variante castigada no puede elegirse como padre: el clic solo
     la previsualiza. Se desmarca con clic derecho → Quitar castigo. */
  if(cellIdx!==CENTER_CELL && typeof isPunishedGenome==="function" && isPunishedGenome(genomeAtCell(cellIdx))){
    showPreview(cellIdx,true);
    showDetail(cellIdx);
    showToast("Variante castigada: no puede ser padre. Clic derecho para quitar el castigo.");
    return;
  }
  selected[cellIdx]=!selected[cellIdx];
  if(!selected[cellIdx]) delete selected[cellIdx];
  cellEls[cellIdx].setAttribute("aria-pressed", selected[cellIdx]?"true":"false");
  showPreview(cellIdx,true);
  showDetail(cellIdx);
  syncSelectionUI();
}
function syncSelectionUI(){
  var n=Object.keys(selected).length;
  selCountEl.textContent= n+" elegido"+(n===1?"":"s");
  btnEvolve.disabled= rendering || n===0 || (typeof genePhase!=="undefined" && genePhase);
  var dnaSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2c0 5 8 5 8 10s-8 5-8 10"/><path d="M16 2c0 5-8 5-8 10s8 5 8 10"/><path d="M9.6 5.2h4.8"/><path d="M9.6 18.8h4.8"/></svg>';
  btnEvolve.innerHTML= n===0 ? dnaSvg+'Evolucionar' : dnaSvg+'Evolucionar ('+n+')';
}

/* ---------- Detalle / receta ---------- */
var detailTitle=document.getElementById("detailTitle"), detailLineage=document.getElementById("detailLineage"),
    recipeEl=document.getElementById("recipe");
/* Paso del slider según el rango del gen: rangos grandes (tonos) de 1 en 1,
   rangos cortos con dos decimales. */
/* Valor legible de un gen: EV con signo, Kelvin con K, tone mapping por nombre */
function fmtGeneVal(gkey, v){
  if(v===undefined) v=0;
  if(gkey==="tonemap") return TONEMAP_NAMES[Math.round(v)]||"";
  if(gkey==="sat") return SAT_NAMES[Math.round(v)]||"";
  if(gkey==="satAmt") return "\u00d7"+v.toFixed(2);
  if(gkey==="huesel") return Math.round(v)+"\u00b0";
  if(gkey==="hueselShift") return (v>0?"+":"")+Math.round(v)+"\u00b0";
  if(gkey==="wbk") return Math.round(v)+"K";
  if(gkey==="exp") return (v>0?"+":"")+v.toFixed(2);
  if(gkey==="curves"||gkey==="curvesLift"||gkey==="curvesShad"||gkey==="curvesHigh") return (v>0?"+":"")+v.toFixed(2);
  return v.toFixed(2);
}
function geneStepSize(gkey, min, max){
  if(gkey==="filmVar") return 1;
  if(gkey==="tonemap"||gkey==="sat") return 1;
  var r=max-min;
  if(r>40) return 1;
  if(r>4) return 0.1;
  return 0.01;
}
/* Al mover un slider se re-renderiza la miniatura de esa celda y, si es la
   que se está previsualizando, también el antes/después en alta resolución.
   Se agrupan los eventos «input» para no renderizar en cada micropaso. */
var editRenderTimer=null, editRenderCell=-1;
function scheduleEditRender(cellIdx){
  editRenderCell=cellIdx;
  if(editRenderTimer) return;
  editRenderTimer=setTimeout(function(){
    editRenderTimer=null;
    var ci=editRenderCell;
    if(rendering || !source || ci<0 || !cellEls[ci]) return;
    var g=genomeAtCell(ci);
    var cv=cellEls[ci].querySelector("canvas");
    if(cv) renderThumbInto(cv, ci===CENTER_CELL?null:g);
    if(previewCell===ci){
      if(previewTimer){ clearTimeout(previewTimer); previewTimer=null; }
      renderPreviewHiRes(ci, previewToken);
    }
  }, 35);
}
/* Tooltips de Transformaciones: qué hace cada paso y cada sub-gen. */
var STEP_TIPS={
  exp:"Sube o baja el brillo general.",
  wbk:"Calienta o enfría la imagen.",
  dehaze:"Quita el velo de niebla y devuelve contraste.",
  retinex:"Quita la iluminación y deja el color y el detalle reales.",
  curves:"Ajusta el contraste y la curva tonal.",
  clarity:"Contraste local en los medios tonos.",
  tonemap:"Comprime el rango dinámico para que luces y sombras quepan en pantalla.",
  loclap:"Realza el detalle fino sin crear halos.",
  guided:"Realza el detalle fino con filtro guiado.",
  sat:"Ajusta la intensidad del color.",
  huesel:"Gira el tono y desplaza colores concretos."
};
var LUT_TIP="Aplica una tabla de color 3D con la intensidad elegida.";
function stepTipFor(key){ if(!key) return ""; if(key.slice(0,3)==="lut") return LUT_TIP; return STEP_TIPS[key]||""; }
var GENE_TIPS={
  exp:"Sube o baja el brillo general.",
  wbk:"Calienta o enfría la imagen.",
  dehaze:"Quita el velo de niebla y devuelve contraste.",
  retinex:"Quita la iluminación y deja el color y el detalle reales.",
  curves:"Acentúa el contraste en los medios tonos.",
  curvesLift:"Levanta o baja las sombras.",
  curvesGamma:"Ajusta los tonos medios.",
  curvesGain:"Ajusta las luces.",
  curvesShad:"Ajusta solo las zonas oscuras.",
  curvesHigh:"Ajusta solo las zonas claras.",
  clarity:"Contraste local en los medios tonos.",
  tonemap:"Comprime el rango dinámico para que luces y sombras quepan en pantalla.",
  tonemapAmt:"Comprime el rango dinámico para que luces y sombras quepan en pantalla.",
  loclap:"Realza el detalle fino sin crear halos.",
  guided:"Realza el detalle fino con filtro guiado.",
  sat:"Ajusta la intensidad del color.",
  satAmt:"Ajusta la intensidad del color.",
  huesel:"Gira el tono y desplaza colores concretos.",
  hueselShift:"Gira el tono y desplaza colores concretos."
};
function geneTipFor(gkey){ if(!gkey) return ""; if(gkey.slice(0,3)==="lut") return LUT_TIP; return GENE_TIPS[gkey]||stepTipFor(gkey); }
function makeGeneSlider(cellIdx, g, gene, labelText, onChange){
  var row=document.createElement("div"); row.className="gene-slider";
  if(labelText){
    var lab=document.createElement("span"); lab.className="glabel"; lab.textContent=labelText;
    row.appendChild(lab);
  }
  var input=document.createElement("input");
  input.type="range"; input.min=gene.min; input.max=gene.max;
  input.dataset.gkey=gene.gkey;
  input.step=geneStepSize(gene.gkey, gene.min, gene.max);
  var cur=g.values[gene.gkey];
  input.value=(cur!==undefined?cur:gene.def);
  input.setAttribute("aria-label", gene.label||labelText||gene.gkey);
  var gTip=geneTipFor(gene.gkey);
  if(gTip) input.title=gTip;
  var val=document.createElement("span"); val.className="gval";
  if(gTip){ row.title=gTip; if(typeof lab!=="undefined" && lab) lab.title=gTip; val.title=gTip; }
  val.textContent=fmtGeneVal(gene.gkey, parseFloat(input.value));
  input.addEventListener("input", function(){
    var nv=parseFloat(input.value);
    g.values[gene.gkey]=nv; /* el genoma queda modificado: se evoluciona y se descarga con este valor */
    val.textContent=fmtGeneVal(gene.gkey, nv);
    if(onChange) onChange();
    scheduleEditRender(cellIdx);
    scheduleDiagUpdate();
    var st=input.closest ? input.closest(".step") : null;
    if(st) refreshResetStates(st, g);
  });
  row.appendChild(input); row.appendChild(val);
  return row;
}
/* ---------- Transformaciones: restablecer + diagnóstico por paso ----------
   Diagnóstico: se recorre TODO el pipeline sobre una copia reducida
   (máx. 144 px, todos los pasos activos son puntuales) con la misma
   lógica de salto que processGenome. Antes y después de CADA paso se
   comparan los píxeles flotantes y se atribuye a ese paso:
   · Clipping en luces/sombras: canales que llegan a 255 / 0 sin estarlo.
   · Overflow: cuántos valores distintos quedan aplastados en ese borde
     (lo que superaba el rango se pierde, no se recupera con dithering).
   · Aplanamiento: caída fuerte de la desviación de luma (contraste),
     de la separación entre canales (color) o de niveles de luma únicos.
   · Fuera de gamut: canales que el paso empuja fuera del rango [0, 255]
     en flotante, medidos sobre la salida CRUDA del paso, antes del
     clamp255 que el pipeline aplica al final de cada filtro (con el
     clamp ya aplicado ningún canal quedaría fuera y este aviso jamás
     dispararía). Solo el diagnóstico desactiva el clamp, y solo
     mientras dura el paso; la imagen y la exportación no cambian.
   · Grises neutros con tinte: píxeles casi grises (separación entre
     canales ≤ 10) que salen del paso con tinte notable (separación ≥ 14).
   · Balance de blancos: cambio de la temperatura de color (CCT,
     fórmula de McCamy sobre el color medio, como en los scopes).
   · Tinte verde-magenta: desplazamiento de la media del eje a* de
     CIELAB (verde ↔ magenta), el eje perpendicular a la temperatura
     de color, que el CCT no ve.
   · Saturación excesiva / contraste exagerado: los espejos del
     aplanamiento de color / tonal (subidas fuertes en el mismo paso).
   · Pérdida de detalle en sombras/luces: canales que entran en las
     bandas 0–5 o 250–255, donde el detalle ya casi no se distingue.
   · Punto negro/blanco: percentiles 1 y 99 de luma; avisa si el punto
     negro sube o el punto blanco baja (los extremos se cierran).
   · Cambio de tono: giro circular medio del matiz (hue) en los
     píxeles con color suficiente (separación ≥ 20), en grados.
   · GMSD: desviación de la similitud de magnitud de gradiente (Sobel
     sobre luma) entre el antes y el después del paso; 0 = idéntico.
   · SSIM bajo: SSIM global sobre luma entre el antes y el después del
     paso, con la misma fórmula y constantes del panel Diferencia. */
var diagCanvas=document.createElement("canvas");
/* CCT (McCamy) desde el color medio sRGB 0–255, igual que en los scopes:
   medias → lineal (tabla SRGB_TO_LINEAR) → XYZ → cromaticidad → McCamy.
   Devuelve null si el color medio no da una CCT válida (2000–20000 K). */
function cctFromMeanRGB(mr, mg, mb){
  function lin(v){ return SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(v)))]; }
  var mRl=lin(mr), mGl=lin(mg), mBl=lin(mb);
  var mX=0.4124564*mRl + 0.3575761*mGl + 0.1804375*mBl;
  var mY=0.2126729*mRl + 0.7151522*mGl + 0.0721750*mBl;
  var mZ=0.0193339*mRl + 0.1191920*mGl + 0.9503041*mBl;
  var mSum=mX+mY+mZ;
  if(!(mSum>0.00001)) return null;
  var cx=mX/mSum, cy=mY/mSum;
  if(Math.abs(0.1858-cy)<0.0001) return null;
  var nn=(cx-0.3320)/(0.1858-cy);
  var cct=449*nn*nn*nn + 3525*nn*nn + 6823.3*nn + 5520.33;
  return (cct>=2000 && cct<=20000) ? cct : null;
}
/* Eje a* de CIELAB (verde − / magenta +) de un píxel sRGB 0–255, con la
   misma conversión a lineal y matriz XYZ que cctFromMeanRGB y blanco
   D65. Es el eje perpendicular a la temperatura de color: caza el tinte
   verde-magenta que el balance de blancos (CCT) no ve. */
function labAStar(r, g, b){
  function lin(v){ return SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(v)))]; }
  var rl=lin(r), gl=lin(g), bl=lin(b);
  var fx=(0.4124564*rl + 0.3575761*gl + 0.1804375*bl)/0.95047;
  var fy=(0.2126729*rl + 0.7151522*gl + 0.0721750*bl)/1.0;
  function f(t){ return t>0.008856 ? Math.cbrt(t) : (7.787*t + 16/116); }
  return 500*(f(fx)-f(fy));
}
/* Matiz (hue) en grados 0–360 de un píxel sRGB; -1 si es acromático. */
function hueDeg(r, g, b){
  var mx=Math.max(r, g, b), mn=Math.min(r, g, b), d=mx-mn;
  if(d<0.001) return -1;
  var h;
  if(mx===r) h=((g-b)/d)%6;
  else if(mx===g) h=(b-r)/d+2;
  else h=(r-g)/d+4;
  h*=60; if(h<0) h+=360;
  return h;
}
/* GMSD (Gradient Magnitude Similarity Deviation, Xue et al.) entre el
   antes y el después sobre luma: magnitud de gradiente Sobel (÷4),
   mapa de similitud (2·mB·mA + C)/(mB² + mA² + C) con C = 0.0026·255²
   y desviación típica de ese mapa. 0 = gradientes idénticos; cuanto
   más alto, más irregular es el cambio de bordes y textura. Solo
   píxeles interiores (el borde no tiene vecindario completo). */
function gmsdLuma(before, after, w, h){
  var n=w*h;
  var lb=new Float32Array(n), la=new Float32Array(n);
  for(var i=0, j=0; i<before.length; i+=4, j++){
    lb[j]=0.299*before[i]+0.587*before[i+1]+0.114*before[i+2];
    la[j]=0.299*after[i]+0.587*after[i+1]+0.114*after[i+2];
  }
  var C=0.0026*255*255, cnt=0, sum=0;
  var gms=new Float32Array(n);
  for(var y=1; y<h-1; y++){
    for(var x=1; x<w-1; x++){
      var idx=y*w+x;
      var gxB=((lb[idx-w+1]+2*lb[idx+1]+lb[idx+w+1])-(lb[idx-w-1]+2*lb[idx-1]+lb[idx+w-1]))/4;
      var gyB=((lb[idx+w-1]+2*lb[idx+w]+lb[idx+w+1])-(lb[idx-w-1]+2*lb[idx-w]+lb[idx-w+1]))/4;
      var gxA=((la[idx-w+1]+2*la[idx+1]+la[idx+w+1])-(la[idx-w-1]+2*la[idx-1]+la[idx+w-1]))/4;
      var gyA=((la[idx+w-1]+2*la[idx+w]+la[idx+w+1])-(la[idx-w-1]+2*la[idx-w]+la[idx-w+1]))/4;
      var mB=Math.sqrt(gxB*gxB+gyB*gyB), mA=Math.sqrt(gxA*gxA+gyA*gyA);
      var gv=(2*mB*mA+C)/(mB*mB+mA*mA+C);
      gms[idx]=gv; sum+=gv; cnt++;
    }
  }
  if(cnt<9) return null;
  var mean=sum/cnt, acc=0;
  for(var y2=1; y2<h-1; y2++){
    for(var x2=1; x2<w-1; x2++){ var dd=gms[y2*w+x2]-mean; acc+=dd*dd; }
  }
  return Math.sqrt(acc/cnt);
}
/* ---------- Indicadores de Límites seguros ----------
   Los 18 avisos del diagnóstico por transformación. Cada uno tiene:
   checkbox (activo/inactivo: si está inactivo no bloquea candidatos ni
   genera icono ámbar), slider de umbral (el que usa stepDiagnostics) y
   dos kill counts: histórico de la sesión y de la generación actual.
   Kill = candidato descartado que activó ese aviso y no se mostró en
   la rejilla; un candidato puede contar en varios indicadores y el
   candidato reparado que sí se muestra no cuenta. */
/* Orientación de los sliders: hasta la derecha = filtro más estricto.
   · invert:true (tolerancias: clipping, aplanamientos, posterización,
     gamut, grises neutros, balance de blancos, saturación excesiva,
     pérdida de detalle y contraste exagerado): lo estricto es la
     tolerancia MÁS BAJA, así que la posición del slider se invierte
     respecto al umbral real (derecha = umbral real mínimo).
   · SSIM (invert:false) es un mínimo: lo estricto es el mínimo MÁS
     ALTO, que ya queda a la derecha sin invertir.
   El valor mostrado junto al slider es siempre el umbral real. */
/* Orden de la lista (campo group): arriba los ESENCIALES — salen de la
   misma pasada de píxeles del diagnóstico (baratos) y cazan daño
   objetivo: sin ellos pasan imágenes quemadas, aplastadas, lavadas o
   posterizadas. Abajo los OPCIONALES — son de gusto (un look cálido,
   saturado o con el tono girado puede ser la intención), GMSD es el
   único caro (dos pasadas Sobel extra sobre luma) y SSIM es el más
   estricto: bloquea cualquier cambio claramente perceptible, así que
   es el que más limita la creatividad. Por eso los opcionales nacen
   con defaults permisivos (saturación +120%, contraste +60%, grises
   6%, balance de blancos 1500 K, tinte Δa* 6, tono 20°, luminancia
   media 25%, GMSD 0.18, SSIM mínimo 0.80): solo cazan excesos claros
   y dejan pasar los
   looks creativos; quien quiera más control los endurece a mano. */
var INDICATORS=[
  {id:"clipH", group:"core", label:"Clipping en luces", tip:"Descarta variantes con demasiados píxeles quemados en las luces.", thrLabel:"Umbral", def:0.15, min:0.05, max:5, step:0.05, invert:true, fmt:function(v){return v.toFixed(2)+"%";}},
  {id:"clipL", group:"core", label:"Clipping en sombras", tip:"Descarta variantes con demasiados píxeles aplastados en las sombras.", thrLabel:"Umbral", def:0.15, min:0.05, max:5, step:0.05, invert:true, fmt:function(v){return v.toFixed(2)+"%";}},
  {id:"gamut", group:"core", label:"Fuera de gamut", tip:"Descarta variantes con demasiados colores que no se pueden reproducir en pantalla.", thrLabel:"Umbral", def:0.15, min:0.05, max:5, step:0.05, invert:true, fmt:function(v){return v.toFixed(2)+"%";}},
  {id:"detailLoss", group:"core", label:"Pérdida de detalle", tip:"Descarta variantes que borran detalle en las zonas muy oscuras o muy claras.", thrLabel:"Umbral", def:5, min:0.1, max:10, step:0.1, invert:true, fmt:function(v){return v.toFixed(1)+"%";}},
  {id:"poster", group:"core", label:"Posterización", tip:"Descarta variantes que crean bandas o escalones en los degradados.", thrLabel:"Caída", def:38, min:10, max:80, step:1, invert:true, fmt:function(v){return Math.round(v)+"%";}},
  {id:"flatTone", group:"core", label:"Aplanamiento tonal", tip:"Descarta variantes que aplastan los tonos y dejan la imagen plana.", thrLabel:"Caída", def:22, min:5, max:60, step:1, invert:true, fmt:function(v){return Math.round(v)+"%";}},
  {id:"localContrast", group:"core", label:"Contraste local", tip:"Descarta variantes que pierden contraste en los detalles pequeños.", thrLabel:"Caída", def:30, min:10, max:60, step:1, invert:true, fmt:function(v){return Math.round(v)+"%";}},
  {id:"flatColor", group:"core", label:"Aplanamiento de color", tip:"Descarta variantes que pierden variedad de color.", thrLabel:"Caída", def:40, min:10, max:80, step:1, invert:true, fmt:function(v){return Math.round(v)+"%";}},
  {id:"bwPoint", group:"core", label:"Punto negro/blanco", tip:"Descarta variantes que mueven el negro o el blanco fuera de su rango.", thrLabel:"Cierre", def:10, min:2, max:40, step:1, invert:true, fmt:function(v){return Math.round(v)+" niveles";}},
  {id:"overSat", group:"opt", label:"Saturación excesiva", tip:"Descarta variantes con colores demasiado saturados.", thrLabel:"Subida", def:120, min:20, max:200, step:5, invert:true, fmt:function(v){return Math.round(v)+"%";}},
  {id:"overContrast", group:"opt", label:"Contraste exagerado", tip:"Descarta variantes con el contraste demasiado fuerte.", thrLabel:"Subida", def:60, min:10, max:100, step:5, invert:true, fmt:function(v){return Math.round(v)+"%";}},
  {id:"meanLuma", group:"opt", label:"Luminancia media", tip:"Descarta variantes que cambian demasiado el brillo medio.", thrLabel:"Cambio", def:25, min:10, max:50, step:1, invert:true, fmt:function(v){return Math.round(v)+"%";}},
  {id:"neutralTint", group:"opt", label:"Grises neutros con tinte", tip:"Descarta variantes que tiñen los grises.", thrLabel:"Umbral", def:6, min:0.5, max:20, step:0.5, invert:true, fmt:function(v){return v.toFixed(1)+"%";}},
  {id:"whiteBalance", group:"opt", label:"Balance de blancos", tip:"Descarta variantes con la temperatura de color demasiado desviada.", thrLabel:"Cambio", def:1500, min:100, max:2000, step:50, invert:true, fmt:function(v){return Math.round(v)+" K";}},
  {id:"gmTint", group:"opt", label:"Tinte verde-magenta", tip:"Descarta variantes con un tinte verdoso o magenta.", thrLabel:"Cambio", def:6, min:0.5, max:15, step:0.5, invert:true, fmt:function(v){return "Δa* "+v.toFixed(1);}},
  {id:"hueShift", group:"opt", label:"Cambio de tono", tip:"Descarta variantes que giran el tono demasiado.", thrLabel:"Giro", def:20, min:2, max:45, step:1, invert:true, fmt:function(v){return Math.round(v)+"°";}},
  {id:"gmsd", group:"opt", label:"GMSD", tip:"Descarta variantes que pierden nitidez en los bordes.", thrLabel:"Máximo", def:0.18, min:0.02, max:0.30, step:0.01, invert:true, fmt:function(v){return v.toFixed(2);}},
  {id:"lowSSIM", group:"opt", label:"SSIM bajo", tip:"Descarta variantes demasiado distintas de la original en estructura.", thrLabel:"Mínimo", def:0.80, min:0.70, max:0.99, step:0.01, invert:false, fmt:function(v){return v.toFixed(2);}}
];
var IND_GROUP_LABELS={ core:"Esenciales — baratos, cazan lo roto", opt:"Opcionales — de gusto, caros o limitan la creatividad" };
/* Posición del slider <-> umbral real, según la orientación del indicador. */
function indSliderPos(ind, real){ return ind.invert ? Number((ind.min+ind.max-real).toFixed(4)) : real; }
function indRealFromPos(ind, pos){ return ind.invert ? Number((ind.min+ind.max-pos).toFixed(4)) : pos; }
var IND_BY_ID={};
var indicatorEnabled={}, indicatorThresholds={}, killSession={}, killGen={};
INDICATORS.forEach(function(ind){
  IND_BY_ID[ind.id]=ind;
  indicatorEnabled[ind.id]=true;
  indicatorThresholds[ind.id]=ind.def;
  killSession[ind.id]=0; killGen[ind.id]=0;
});
function indOn(id){ return indicatorEnabled[id]!==false; }
function indThr(id){ var v=indicatorThresholds[id]; return (v===undefined||v===null) ? IND_BY_ID[id].def : v; }
function recordKill(ids){
  if(!ids) return;
  var changed=false;
  for(var id in ids){ if(Object.prototype.hasOwnProperty.call(ids,id) && IND_BY_ID[id]){ killSession[id]++; killGen[id]++; changed=true; } }
  if(changed) updateKillUI();
}
function recordKills(failedList, excludeIndex){
  if(!failedList) return;
  for(var i=0;i<failedList.length;i++){ if(i===excludeIndex) continue; recordKill(failedList[i]); }
}
function resetGenKills(){
  INDICATORS.forEach(function(ind){ killGen[ind.id]=0; });
  updateKillUI();
}
function updateKillUI(){
  var totH=0, totG=0;
  INDICATORS.forEach(function(ind){
    var h=document.getElementById("killHist-"+ind.id), g=document.getElementById("killGen-"+ind.id);
    if(h) h.textContent=String(killSession[ind.id]||0);
    if(g) g.textContent=String(killGen[ind.id]||0);
    totH+=killSession[ind.id]||0; totG+=killGen[ind.id]||0;
  });
  var th=document.getElementById("killHistTotal"), tg=document.getElementById("killGenTotal");
  if(th) th.textContent=String(totH);
  if(tg) tg.textContent=String(totG);
}
function syncIndicatorPanelVisibility(){
  var panel=document.getElementById("indicatorPanel");
  if(!panel) return;
  var chk=document.getElementById("chkSafeBounds");
  panel.hidden=!!(chk && !chk.checked);
}
function buildIndicatorList(){
  var list=document.getElementById("indicatorList");
  if(!list || list.children.length) return;
  var lastGroup=null;
  INDICATORS.forEach(function(ind){
    if(ind.group && ind.group!==lastGroup){
      lastGroup=ind.group;
      var gh=document.createElement("div"); gh.className="ind-group-head"; gh.textContent=IND_GROUP_LABELS[ind.group]||"";
      list.appendChild(gh);
    }
    var row=document.createElement("div"); row.className="ind-row"; row.id="indRow-"+ind.id;
    if(ind.tip) row.title=ind.tip;
    var main=document.createElement("div"); main.className="ind-row-main";
    var lab=document.createElement("label"); lab.setAttribute("for","indChk-"+ind.id);
    if(ind.tip) lab.title=ind.tip;
    var chk=document.createElement("input"); chk.type="checkbox"; chk.id="indChk-"+ind.id; chk.checked=true;
    chk.setAttribute("aria-label","Activar indicador "+ind.label);
    chk.title="Activar o desactivar este aviso.";
    var name=document.createElement("span"); name.textContent=ind.label;
    if(ind.tip) name.title=ind.tip;
    lab.appendChild(chk); lab.appendChild(name);
    var kh=document.createElement("span"); kh.className="ind-kill"; kh.id="killHist-"+ind.id; kh.textContent="0"; kh.title="Eliminaciones históricas de la sesión · "+ind.label;
    var kg=document.createElement("span"); kg.className="ind-kill gen"; kg.id="killGen-"+ind.id; kg.textContent="0"; kg.title="Eliminaciones de la generación actual · "+ind.label;
    main.appendChild(lab); main.appendChild(kh); main.appendChild(kg);
    row.appendChild(main);
    var sliderRow=document.createElement("div"); sliderRow.className="ind-slider";
    var thrLab=document.createElement("span"); thrLab.className="ind-thr-label"; thrLab.textContent=ind.thrLabel;
    if(ind.tip) thrLab.title=ind.tip;
    var slider=document.createElement("input"); slider.type="range"; slider.id="indThr-"+ind.id;
    slider.min=String(ind.min); slider.max=String(ind.max); slider.step=String(ind.step); slider.value=String(indSliderPos(ind, ind.def));
    slider.setAttribute("aria-label","Umbral de "+ind.label+" (a la derecha, más estricto)");
    slider.setAttribute("aria-valuetext", ind.fmt(ind.def));
    slider.title="A la derecha: filtro más estricto · El valor mostrado es el umbral real";
    var thrVal=document.createElement("span"); thrVal.className="ind-thr-val"; thrVal.id="indThrVal-"+ind.id; thrVal.textContent=ind.fmt(ind.def);
    sliderRow.appendChild(thrLab); sliderRow.appendChild(slider); sliderRow.appendChild(thrVal);
    row.appendChild(sliderRow);
    list.appendChild(row);
    chk.addEventListener("change", function(){
      indicatorEnabled[ind.id]=!!chk.checked;
      row.classList.toggle("is-off", !chk.checked);
      slider.disabled=!chk.checked;
      if(typeof scheduleDiagUpdate==="function") scheduleDiagUpdate();
    });
    slider.addEventListener("input", function(){
      var pos=parseFloat(slider.value);
      if(!isNaN(pos)){ var v=indRealFromPos(ind, pos); indicatorThresholds[ind.id]=v; thrVal.textContent=ind.fmt(v); slider.setAttribute("aria-valuetext", ind.fmt(v)); }
      if(typeof scheduleDiagUpdate==="function") scheduleDiagUpdate();
    });
  });
  var safeChk=document.getElementById("chkSafeBounds");
  if(safeChk && !safeChk.dataset.indWired){
    safeChk.dataset.indWired="1";
    safeChk.addEventListener("change", syncIndicatorPanelVisibility);
  }
  syncIndicatorPanelVisibility();
  updateKillUI();
}
buildIndicatorList();
/* ---------- Secciones plegables: Límites seguros y Brújula ---------- */
/* La flecha de cada cabecera expande o colapsa toda su sección. El
   checkbox sigue mandando sobre si la función está activa (al
   desactivarlo, el panel se oculta como antes); la flecha solo pliega. */
document.querySelectorAll(".collapse-arrow").forEach(function(btn){
  btn.addEventListener("click", function(){
    var wrap=btn.closest(".collapsible");
    if(!wrap) return;
    var collapsed=wrap.classList.toggle("is-collapsed");
    btn.textContent=collapsed?"▶":"▼";
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.title=collapsed?"Expandir sección":"Contraer sección";
  });
});
/* gamutPre (opcional): canales fuera de [0, 255] contados por
   analyzePipelineDetailed sobre la salida cruda del paso, antes de
   recortarla. «after» ya viene recortado (igual que la imagen real),
   así que sin gamutPre el conteo de gamut de este bucle daría siempre
   0: todos los demás indicadores se miden sobre «after» recortado,
   como hasta ahora. */
function stepDiagnostics(before, after, npix, gamutPre, w, h){
  var totalCh=npix*3, clipH=0, clipL=0;
  var seenH=new Uint8Array(256), seenL=new Uint8Array(256);
  var seenLB=new Uint8Array(256), seenLA=new Uint8Array(256);
  var histLB=new Uint32Array(256), histLA=new Uint32Array(256);
  var sumB=0, sumB2=0, sumA=0, sumA2=0, satB=0, satA=0;
  var gamutOut=0, detL=0, detH=0, sumBA=0;
  var sumRB=0, sumGB=0, sumBB=0, sumRA=0, sumGA=0, sumBA2=0;
  var neutTotal=0, neutTinted=0;
  var sumAsB=0, sumAsA=0, hueCos=0, hueSin=0, hueN=0;
  /* Contraste local: suma y suma de cuadrados de luma por bloque 8×8,
     acumulados en esta misma pasada. La desviación típica media por
     bloque mide la textura local; el aplanamiento tonal solo ve la
     desviación global, así que un paso puede matar el detalle fino
     sin tocar el rango global y este indicador es el que lo caza. */
  var lcNB=0, lcSumB=null, lcSqB=null, lcSumA=null, lcSqA=null, lcCnt=null;
  if(w && h && w>2 && h>2){
    lcNB=Math.ceil(w/8);
    var lcNBlocks=lcNB*Math.ceil(h/8);
    lcSumB=new Float64Array(lcNBlocks); lcSqB=new Float64Array(lcNBlocks);
    lcSumA=new Float64Array(lcNBlocks); lcSqA=new Float64Array(lcNBlocks);
    lcCnt=new Uint32Array(lcNBlocks);
  }
  for(var i=0;i<before.length;i+=4){
    var lb=0, la=0;
    for(var c=0;c<3;c++){
      var b=before[i+c], a=after[i+c];
      if(a>=254.5 && b<254.5){ clipH++; seenH[Math.max(0,Math.min(255,Math.round(b)))]=1; }
      else if(a<=0.5 && b>0.5){ clipL++; seenL[Math.max(0,Math.min(255,Math.round(b)))]=1; }
      if((a<0 || a>255) && b>=0 && b<=255) gamutOut++;
      if(a<=5 && b>5) detL++;
      else if(a>=250 && b<250) detH++;
    }
    var b0=before[i], b1=before[i+1], b2=before[i+2];
    var a0=after[i], a1=after[i+1], a2=after[i+2];
    lb=0.299*b0+0.587*b1+0.114*b2; la=0.299*a0+0.587*a1+0.114*a2;
    sumB+=lb; sumB2+=lb*lb; sumA+=la; sumA2+=la*la; sumBA+=lb*la;
    if(lcSumB){
      var pj=i>>2, pbi=(((pj/w)|0)>>3)*lcNB + ((pj%w)>>3);
      lcSumB[pbi]+=lb; lcSqB[pbi]+=lb*lb; lcSumA[pbi]+=la; lcSqA[pbi]+=la*la; lcCnt[pbi]++;
    }
    var sepB=Math.max(b0,b1,b2)-Math.min(b0,b1,b2);
    var sepA=Math.max(a0,a1,a2)-Math.min(a0,a1,a2);
    satB+=sepB;
    satA+=sepA;
    if(sepB<=10){ neutTotal++; if(sepA>=14) neutTinted++; }
    sumRB+=b0; sumGB+=b1; sumBB+=b2; sumRA+=a0; sumGA+=a1; sumBA2+=a2;
    var lbR=Math.max(0,Math.min(255,Math.round(lb))), laR=Math.max(0,Math.min(255,Math.round(la)));
    seenLB[lbR]=1; seenLA[laR]=1;
    histLB[lbR]++; histLA[laR]++;
    sumAsB+=labAStar(b0,b1,b2); sumAsA+=labAStar(a0,a1,a2);
    if(sepB>=20 && sepA>=20){
      var hB=hueDeg(b0,b1,b2), hA=hueDeg(a0,a1,a2);
      if(hB>=0 && hA>=0){
        var dh=(hA-hB)*Math.PI/180;
        hueCos+=Math.cos(dh); hueSin+=Math.sin(dh); hueN++;
      }
    }
  }
  function countSeen(arr){ var n=0; for(var k=0;k<256;k++) n+=arr[k]; return n; }
  var msgs=[], ids={};
  function addMsg(id, text){ if(!indOn(id)) return; msgs.push(text); ids[id]=true; }
  var pctH=clipH/totalCh*100, pctL=clipL/totalCh*100;
  if(pctH>=indThr("clipH")){
    var dH=countSeen(seenH);
    addMsg("clipH", "Clipping en luces: el "+pctH.toFixed(1)+"% de los canales llega a 255 en este paso"
      +(dH>=6 ? " y "+dH+" valores distintos quedan aplastados a 255 (overflow: lo que pasaba de 255 se pierde)." : "."));
  }
  if(pctL>=indThr("clipL")){
    var dL=countSeen(seenL);
    addMsg("clipL", "Clipping en sombras: el "+pctL.toFixed(1)+"% de los canales cae a 0 en este paso"
      +(dL>=6 ? " y "+dL+" valores distintos quedan aplastados a 0 (overflow: lo que bajaba de 0 se pierde)." : "."));
  }
  var meanB=sumB/npix, meanA=sumA/npix;
  var sdB=Math.sqrt(Math.max(0,sumB2/npix-meanB*meanB)), sdA=Math.sqrt(Math.max(0,sumA2/npix-meanA*meanA));
  if(sdB>4 && sdA<sdB*(1-indThr("flatTone")/100)){
    addMsg("flatTone", "Aplanamiento tonal: el contraste (desviación de luma) cae un "+Math.round((1-sdA/sdB)*100)+"% en este paso.");
  }
  if(lcSumB){
    var lcTotB=0, lcTotA=0, lcBlocks=0;
    for(var lcb=0; lcb<lcCnt.length; lcb++){
      var lcn=lcCnt[lcb]; if(lcn<4) continue;
      var lcmB=lcSumB[lcb]/lcn, lcmA=lcSumA[lcb]/lcn;
      lcTotB+=Math.sqrt(Math.max(0, lcSqB[lcb]/lcn-lcmB*lcmB));
      lcTotA+=Math.sqrt(Math.max(0, lcSqA[lcb]/lcn-lcmA*lcmA));
      lcBlocks++;
    }
    if(lcBlocks>0){
      var lcMeanB=lcTotB/lcBlocks, lcMeanA=lcTotA/lcBlocks;
      if(lcMeanB>1 && lcMeanA<lcMeanB*(1-indThr("localContrast")/100)){
        addMsg("localContrast", "Contraste local: la textura (desviación de luma en bloques 8×8) cae un "+Math.round((1-lcMeanA/lcMeanB)*100)+"% en este paso; el detalle fino se aplana aunque el contraste global se mantenga.");
      }
    }
  }
  if(sdB>4 && sdA>sdB*(1+indThr("overContrast")/100)){
    addMsg("overContrast", "Contraste exagerado: el contraste (desviación de luma) sube un "+Math.round((sdA/sdB-1)*100)+"% en este paso.");
  }
  if(meanB>1){
    var meanChangePct=Math.abs(meanA-meanB)/meanB*100;
    if(meanChangePct>=indThr("meanLuma")){
      addMsg("meanLuma", "Luminancia media: la luminancia media pasa de "+meanB.toFixed(1)+" a "+meanA.toFixed(1)+" en este paso (cambio del "+Math.round(meanChangePct)+"%); la exposición cambia de forma notable.");
    }
  }
  if(hueN>=30){
    var meanHueShift=Math.atan2(hueSin/hueN, hueCos/hueN)*180/Math.PI;
    if(Math.abs(meanHueShift)>=indThr("hueShift")){
      addMsg("hueShift", "Cambio de tono: el matiz medio de los píxeles con color gira "+(meanHueShift>0?"+":"")+meanHueShift.toFixed(1)+"° en este paso; los colores se desplazan hacia otro tono.");
    }
  }
  var msB=satB/npix, msA=satA/npix;
  if(msB>8 && msA<msB*(1-indThr("flatColor")/100)){
    addMsg("flatColor", "Aplanamiento de color: la separación entre canales cae un "+Math.round((1-msA/msB)*100)+"% en este paso.");
  }
  if(msB>8 && msA>msB*(1+indThr("overSat")/100)){
    addMsg("overSat", "Saturación excesiva: la separación entre canales sube un "+Math.round((msA/msB-1)*100)+"% en este paso.");
  }
  var uB=countSeen(seenLB), uA=countSeen(seenLA);
  if(uB>=40 && uA<uB*(1-indThr("poster")/100)){
    addMsg("poster", "Posterización: los niveles de luma pasan de "+uB+" a "+uA+" en este paso; detalle de gradiente perdido.");
  }
  if(typeof gamutPre==="number") gamutOut=gamutPre; /* conteo real, previo al clamp */
  var pctG=gamutOut/totalCh*100;
  if(pctG>=indThr("gamut")){
    addMsg("gamut", "Fuera de gamut: el "+pctG.toFixed(1)+"% de los canales sale del rango [0, 255] en este paso.");
  }
  if(neutTotal>=30){
    var pctN=neutTinted/neutTotal*100;
    if(pctN>=indThr("neutralTint")){
      addMsg("neutralTint", "Grises neutros con tinte: el "+pctN.toFixed(1)+"% de los píxeles casi grises gana un tinte notable en este paso.");
    }
  }
  var cctB=cctFromMeanRGB(sumRB/npix, sumGB/npix, sumBB/npix);
  var cctA=cctFromMeanRGB(sumRA/npix, sumGA/npix, sumBA2/npix);
  if(cctB!==null && cctA!==null && Math.abs(cctA-cctB)>indThr("whiteBalance")){
    addMsg("whiteBalance", "Balance de blancos: la temperatura de color pasa de "+(Math.round(cctB/50)*50)+" K a "+(Math.round(cctA/50)*50)+" K en este paso (cambio de "+Math.round(Math.abs(cctA-cctB))+" K).");
  }
  var dAStar=sumAsA/npix - sumAsB/npix;
  if(Math.abs(dAStar)>=indThr("gmTint")){
    addMsg("gmTint", "Tinte verde-magenta: el eje a* medio de CIELAB se desplaza "+(dAStar>0?"+":"")+dAStar.toFixed(1)+" en este paso (hacia el "+(dAStar>0?"magenta":"verde")+"); la temperatura de color no lo caza.");
  }
  var pctD=(detL+detH)/totalCh*100;
  if(pctD>=indThr("detailLoss")){
    addMsg("detailLoss", "Pérdida de detalle: el "+pctD.toFixed(1)+"% de los canales cae en 0–5 o 250–255 en este paso (sombras "+(detL/totalCh*100).toFixed(1)+"%, luces "+(detH/totalCh*100).toFixed(1)+"%); el detalle en esas bandas casi desaparece.");
  }
  function pctFromHist(hist, p){
    var target=p*npix, acc=0;
    for(var k=0;k<256;k++){ acc+=hist[k]; if(acc>=target) return k; }
    return 255;
  }
  var bpB=pctFromHist(histLB, 0.01), bpA=pctFromHist(histLA, 0.01);
  var wpB=pctFromHist(histLB, 0.99), wpA=pctFromHist(histLA, 0.99);
  var bpShift=bpA-bpB, wpShift=wpB-wpA, bwThr=indThr("bwPoint");
  if(bpShift>=bwThr || wpShift>=bwThr){
    var bwParts=[];
    if(bpShift>=bwThr) bwParts.push("el punto negro sube de "+bpB+" a "+bpA);
    if(wpShift>=bwThr) bwParts.push("el punto blanco baja de "+wpB+" a "+wpA);
    addMsg("bwPoint", "Punto negro/blanco: "+bwParts.join(" y ")+" en este paso; los extremos se cierran y la imagen se lava.");
  }
  /* SSIM global sobre luma, la misma fórmula del panel Diferencia
     (C1 = 6.5025, C2 = 58.5225, sobre medias/varianzas/covarianza). */
  var varB=sdB*sdB, varA=sdA*sdA, covBA=sumBA/npix-meanB*meanA;
  var denS=(meanB*meanB+meanA*meanA+6.5025)*(varB+varA+58.5225);
  var ssimStep= denS>0 ? ((2*meanB*meanA+6.5025)*(2*covBA+58.5225))/denS : 1;
  if(ssimStep>1) ssimStep=1; if(ssimStep<-1) ssimStep=-1;
  if(ssimStep<indThr("lowSSIM")){
    addMsg("lowSSIM", "SSIM bajo: la similitud estructural de este paso cae a "+ssimStep.toFixed(3)+" (por debajo de "+indThr("lowSSIM").toFixed(2)+"); el cambio ya es claramente perceptible.");
  }
  if(w && h && w>2 && h>2){
    var gmsdVal=gmsdLuma(before, after, w, h);
    if(gmsdVal!==null && gmsdVal>=indThr("gmsd")){
      addMsg("gmsd", "GMSD: la desviación de similitud de gradiente llega a "+gmsdVal.toFixed(3)+" en este paso (máximo "+indThr("gmsd").toFixed(2)+"); bordes y textura cambian de forma irregular.");
    }
  }
  return {msgs:msgs, ids:ids};
}
function analyzePipelineDetailed(g, maxDimOverride){
  var map={}, allIds={};
  if(!g || !workCanvas || !workCanvas.width || !TW || !TH) return {map:map, ids:allIds};
  var maxD=maxDimOverride||144, sc=Math.min(maxD/TW, maxD/TH, 1);
  var aw=Math.max(8, Math.round(TW*sc)), ah=Math.max(8, Math.round(TH*sc));
  diagCanvas.width=aw; diagCanvas.height=ah;
  var dctx=diagCanvas.getContext("2d");
  dctx.imageSmoothingEnabled=true; dctx.imageSmoothingQuality="high";
  var base;
  try{ dctx.drawImage(workCanvas,0,0,aw,ah); base=dctx.getImageData(0,0,aw,ah); }catch(e){ return {map:map, ids:allIds}; }
  var n=base.data.length, npix=aw*ah;
  var fd=new Float32Array(n);
  for(var q=0;q<n;q++) fd[q]=base.data[q];
  var view={data:fd, width:aw, height:ah};
  for(var i=0;i<g.order.length;i++){
    var key=g.order[i], f=FBY[key];
    if(!f) continue;
    var before=null;
    if(f.key2){
      if(g.values[key]===undefined) continue;
      var arr=geneParams(f, g.values);
      if(paramsNeutral(key, arr)) continue;
      before=fd.slice();
      try{ DIAG_RAW_GAMUT=true; applyOp(view, key, arr); DIAG_RAW_GAMUT=false; }catch(e){ DIAG_RAW_GAMUT=false; continue; }
    }else{
      var v=g.values[key];
      if(v===f.def || v===undefined) continue;
      before=fd.slice();
      try{ DIAG_RAW_GAMUT=true; applyOp(view, key, v); DIAG_RAW_GAMUT=false; }catch(e){ DIAG_RAW_GAMUT=false; continue; }
    }
    /* fd guarda la salida CRUDA del paso (sin clamp255): contar aquí
       los canales fuera de [0, 255] — ese es el gamut real del paso —
       y recortar fd enseguida, igual que hace el pipeline real, para
       que el paso siguiente reciba la misma entrada de siempre y los
       demás indicadores se midan sobre la salida recortada. */
    var gamutRaw=0;
    for(var gi=0;gi<fd.length;gi+=4){
      for(var gc=0;gc<3;gc++){
        var ga=fd[gi+gc], gb=before[gi+gc];
        if((ga<0 || ga>255) && gb>=0 && gb<=255) gamutRaw++;
        fd[gi+gc]= ga<0?0 : ga>255?255 : ga;
      }
    }
    var diag=stepDiagnostics(before, fd, npix, gamutRaw, aw, ah);
    var msgs=diag.msgs||[];
    if(msgs.length){ map[key]=msgs; for(var idk in diag.ids){ if(Object.prototype.hasOwnProperty.call(diag.ids,idk)) allIds[idk]=true; } }
  }
  /* Estadística global de la imagen final (tras todos los pasos): una
     variante degenerada (casi todo negro o casi todo blanco) se veta en
     Gen 0 aunque sus avisos quepan en la tolerancia — es un extremo sin
     contenido, no una ruta. fd ya viene recortado a [0,255] tras cada
     paso, así que la media y los porcentajes de 0/255 son comparables. */
  var lumSum=0, c0=0, c255=0, tot=0;
  for(var fi=0;fi<fd.length;fi+=4){
    lumSum+=0.299*fd[fi]+0.587*fd[fi+1]+0.114*fd[fi+2];
    for(var fc=0;fc<3;fc++){ var fv=fd[fi+fc]; tot++; if(fv<=0)c0++; else if(fv>=255)c255++; }
  }
  var fmean=npix?lumSum/npix:0;
  var final={mean:fmean, pct0:tot?100*c0/tot:0, pct255:tot?100*c255/tot:0};
  return {map:map, ids:allIds, final:final};
}
function analyzePipeline(g, maxDimOverride){
  return analyzePipelineDetailed(g, maxDimOverride).map;
}
function makeWarnEl(msgs){
  var text=msgs.join(" ");
  var el=document.createElement("span");
  el.className="step-warn"; el.tabIndex=0; el.setAttribute("role","img");
  el.setAttribute("aria-label","Aviso: "+text); el.title=text;
  el.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  var tip=document.createElement("span"); tip.className="warn-tip"; tip.textContent=text;
  el.appendChild(tip);
  return el;
}
/* ¿Está este filtro (gen principal + sub-genes) en sus valores por defecto? */
function isStepAtDefault(g, f){
  var v=g.values[f.key];
  if((v===undefined? f.def : v)!==f.def) return false;
  var subs=subGenesOf(f);
  for(var i=0;i<subs.length;i++){
    var w=g.values[subs[i].gkey];
    if((w===undefined? subs[i].def : w)!==subs[i].def) return false;
  }
  return true;
}
function refreshResetStates(step, g){
  if(!step || !g) return;
  var key=step.dataset? step.dataset.key : null;
  var btn=step.querySelector(".step-reset");
  if(!key || !btn || !FBY[key]) return;
  btn.disabled= isStepAtDefault(g, FBY[key]) || genePins[key]!==undefined; /* fijado: tampoco se puede restablecer */
}
function makeResetButton(cellIdx, g, f, step, refreshHead){
  var b=document.createElement("button");
  b.type="button"; b.className="step-reset";
  b.title="Volver este gen a su valor original.";
  b.setAttribute("aria-label","Restablecer "+f.label+" a su valor por defecto");
  b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
  b.disabled=isStepAtDefault(g, f);
  b.addEventListener("click", function(){
    g.values[f.key]=f.def;
    subGenesOf(f).forEach(function(sg){ g.values[sg.gkey]=sg.def; });
    if(step){
      step.querySelectorAll("input[type=range][data-gkey]").forEach(function(inp){
        var gk=inp.dataset.gkey, def=null;
        if(gk===f.key) def=f.def;
        else subGenesOf(f).forEach(function(sg){ if(sg.gkey===gk) def=sg.def; });
        if(def===null) return;
        inp.value=def;
        var val=inp.parentElement? inp.parentElement.querySelector(".gval") : null;
        if(val) val.textContent=fmtGeneVal(gk, def);
      });
    }
    if(refreshHead) refreshHead();
    b.disabled=true;
    scheduleEditRender(cellIdx);
    scheduleDiagUpdate();
    showToast("«"+f.label+"» restablecido a su valor por defecto.");
  });
  return b;
}
/* ---------- Pin global de genes (botón de candado) ----------
   Fija el valor actual de este filtro (gen principal + sub-genes) en
   genePins: todos los hijos de las siguientes generaciones lo reciben
   tal cual, desciendan de quien desciendan. Mientras está fijado, los
   sliders de la fila y su botón de restablecer quedan bloqueados. */
function stepPinned(f){ return genePins[f.key]!==undefined; }
function applyStepPinState(step, g, f){
  if(!step) return;
  var pinned=stepPinned(f);
  step.classList.toggle("pinned", pinned);
  step.querySelectorAll("input[type=range][data-gkey]").forEach(function(inp){ inp.disabled=pinned; });
  var rb=step.querySelector(".step-reset");
  if(rb) rb.disabled= pinned || isStepAtDefault(g, f);
}
function makePinButton(cellIdx, g, f, step){
  var b=document.createElement("button");
  b.type="button"; b.className="step-pin";
  var LOCK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  var OPEN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
  function sync(){
    var pinned=stepPinned(f);
    b.classList.toggle("pinned", pinned);
    b.innerHTML= pinned? LOCK : OPEN;
    b.title= pinned? "Este valor está fijado para todas las generaciones siguientes (pin global) · clic para soltar"
                   : "Fijar este valor para todas las generaciones siguientes (pin global).";
    b.setAttribute("aria-label", (pinned? "Soltar el pin global de " : "Fijar con pin global ")+f.label);
    b.setAttribute("aria-pressed", pinned? "true" : "false");
  }
  b.addEventListener("click", function(){
    if(stepPinned(f)){
      delete genePins[f.key];
      subGenesOf(f).forEach(function(sg){ delete genePins[sg.gkey]; });
      showToast("«"+f.label+"» ya no está fijado.");
    }else{
      genePins[f.key]= (g.values[f.key]!==undefined? g.values[f.key] : f.def);
      subGenesOf(f).forEach(function(sg){ genePins[sg.gkey]= (g.values[sg.gkey]!==undefined? g.values[sg.gkey] : sg.def); });
      showToast("«"+f.label+"» fijado en "+fmtGeneVal(f.key, genePins[f.key])+": todos los hijos lo heredan así.");
    }
    sync();
    applyStepPinState(step, g, f);
  });
  sync();
  return b;
}
/* Tras mover sliders, los avisos se recalculan sin reconstruir la receta
   (reconstruirla haría perder el foco del slider que se está arrastrando). */
var diagTimer=null;
function scheduleDiagUpdate(){
  if(diagTimer) return;
  diagTimer=setTimeout(function(){ diagTimer=null; refreshStepDiagnostics(); }, 280);
}
function refreshStepDiagnostics(){
  if(detailCell<0 || !recipeEl) return;
  if(typeof transformPanel!=="undefined" && transformPanel && transformPanel.hidden) return;
  var g=genomeAtCell(detailCell);
  if(!g) return;
  var map=analyzePipeline(g);
  recipeEl.querySelectorAll(".step").forEach(function(step){
    var key=step.dataset? step.dataset.key : null;
    if(!key) return;
    var head=step.querySelector(".step-head") || step;
    var old=head.querySelector(".step-warn");
    if(old) old.remove();
    var msgs=map[key];
    if(msgs && msgs.length){
      var warn=makeWarnEl(msgs);
      var reset=head.querySelector(".step-reset");
      if(reset) head.insertBefore(warn, reset); else head.appendChild(warn);
    }
    refreshResetStates(step, g);
  });
}
/* ---------- Descarga .cube de una LUT 3D (33×33×33, Float32 completo) ---------- */
function lutName(idx){
  var cu=(typeof CUSTOM_BY_IDX!=="undefined")? CUSTOM_BY_IDX[idx] : null;
  if(cu) return cu.name.replace(/\.cube$/i,"");
  if(idx<LUT_DEFS.length) return LUT_DEFS[idx].name;
  var d=LUT_EXT_DEFS[idx-LUT_DEFS.length];
  return d? d.name : ("LUT "+idx);
}
function downloadLutCube(idx){
  if(!LUTS[idx]) return;
  var name=lutName(idx);
  /* La descarga individual también es 65³: se genera bajo demanda si
     aún no existe (el indicador «65³…» se muestra mientras tanto). */
  ensureLut65(idx, function(data65){
    var data=data65||LUTS[idx]; if(!data) return;
    var S=data65 ? LUT65_SIZE : LUT_SIZE;
    /* Orden .cube estándar: R rápido, luego G, luego B — el mismo orden en el
       que la rejilla guarda la malla, así que basta recorrer el array en orden. */
    var parts=['TITLE "'+name.replace(/"/g,"")+'"',
               "LUT_3D_SIZE "+S,
               "DOMAIN_MIN 0.0 0.0 0.0",
               "DOMAIN_MAX 1.0 1.0 1.0"];
    for(var p=0;p<data.length;p+=3){
      parts.push(data[p].toFixed(6)+" "+data[p+1].toFixed(6)+" "+data[p+2].toFixed(6));
    }
    var blob=new Blob([parts.join("\n")+"\n"],{type:"text/plain;charset=utf-8"});
    var a=document.createElement("a");
    a.href=URL.createObjectURL(blob); a.download=name+".cube";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); },4000);
    showToast("LUT «"+name+"» descargada (.cube "+S+"³).");
  });
}
/* ---------- LUT horneada: una sola LUT equivalente a todo el genoma ----------
   Para cada nodo de la malla 33³ se toma su color (r,g,b) y se le aplica,
   en el orden del genoma, la cadena completa: primero los pasos puntuales
   de grading (exposición, balance de blancos, contraste y curvas, tone
   mapping, saturación y hue selectivo, que al ser operaciones por píxel
   también caben en una LUT 3D) y después cada LUT activa mezclada con su
   intensidad exacta (salida = entrada·(1−t) +
   LUT(entrada)·t), muestreando cada LUT con interpolación trilineal en
   flotante — el mismo muestreo que applyLut3D hace sobre la imagen, sin
   pasar por 8 bits. El resultado se guarda como el valor de ese nodo en
   la LUT horneada: aplicada sola a intensidad 1 reproduce el efecto
   completo de la variante. */
function sampleLutFloat(data, r, g, b, out){
  var S=Math.round(Math.cbrt(data.length/3)); if(!(S>=2)) S=LUT_SIZE;
  var px=r*(S-1), py=g*(S-1), pz=b*(S-1);
  var x0,y0,z0,x1,y1,z1,fx,fy,fz;
  if(px<=0){ x0=0; x1=0; fx=0; } else if(px>=S-1){ x0=S-1; x1=S-1; fx=0; } else { x0=Math.floor(px); x1=x0+1; fx=px-x0; }
  if(py<=0){ y0=0; y1=0; fy=0; } else if(py>=S-1){ y0=S-1; y1=S-1; fy=0; } else { y0=Math.floor(py); y1=y0+1; fy=py-y0; }
  if(pz<=0){ z0=0; z1=0; fz=0; } else if(pz>=S-1){ z0=S-1; z1=S-1; fz=0; } else { z0=Math.floor(pz); z1=z0+1; fz=pz-z0; }
  var i000=((z0*S+y0)*S+x0)*3, i100=((z0*S+y0)*S+x1)*3;
  var i010=((z0*S+y1)*S+x0)*3, i110=((z0*S+y1)*S+x1)*3;
  var i001=((z1*S+y0)*S+x0)*3, i101=((z1*S+y0)*S+x1)*3;
  var i011=((z1*S+y1)*S+x0)*3, i111=((z1*S+y1)*S+x1)*3;
  for(var c=0;c<3;c++){
    var v00=data[i000+c] + fx*(data[i100+c]-data[i000+c]);
    var v10=data[i010+c] + fx*(data[i110+c]-data[i010+c]);
    var v01=data[i001+c] + fx*(data[i101+c]-data[i001+c]);
    var v11=data[i011+c] + fx*(data[i111+c]-data[i011+c]);
    var v0=v00 + fy*(v10-v00), v1=v01 + fy*(v11-v01);
    out[c]=v0 + fz*(v1-v0);
  }
}
function activeLutsOf(genome){
  var act=[];
  if(!genome) return act;
  genome.order.forEach(function(key){
    if(key.slice(0,3)!=="lut") return;
    var v=genome.values[key];
    if(v===undefined||v===0) return;
    var id=parseInt(key.slice(3),10);
    if(id>=0 && id<LUTS.length && LUTS[id]) act.push({id:id, amt:v});
  });
  return act;
}
/* Pasos puntuales de grading sobre un color flotante 0..1, para hornear */
function bakeLin(c){ return c<=0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
function bakeEnc(c){ if(c<0) c=0; return c<=0.0031308 ? c*12.92 : 1.055*Math.pow(c, 1/2.4)-0.055; }
function bakePointStep(cur, key, v, v2, p){
  var c;
  if(key==="curves"){
    /* La misma matemática que applyCurves, sobre el color flotante. */
    if(!p) return;
    var s=p[0], lift=p[1], invG=1/p[2], gain=p[3], shad=p[4], high=p[5];
    var tmp=[0,0,0];
    for(c=0;c<3;c++){
      var y=cur[c]*gain+lift; if(y<0)y=0; y=Math.pow(y,invG);
      tmp[c]=y + s*3*y*(1-y)*(y-0.5);
    }
    var L=0.299*tmp[0] + 0.587*tmp[1] + 0.114*tmp[2]; if(L<0)L=0; if(L>1)L=1;
    var ws=Math.pow(1-L, 2.2), tt=(L-0.35)/0.65; tt=tt<0?0:tt>1?1:tt;
    var wh=tt*tt*(3-2*tt);
    var fz=1 + shad*0.55*ws + high*0.55*wh, add=shad*ws*20/255;
    for(c=0;c<3;c++) cur[c]=lutC01(tmp[c]*fz+add);
  }else if(key==="exp"){
    var m=Math.pow(2, v);
    for(c=0;c<3;c++) cur[c]=lutC01(bakeEnc(bakeLin(cur[c])*m));
  }else if(key==="wbk"){
    var g=kelvinGains(v);
    for(c=0;c<3;c++) cur[c]=lutC01(cur[c]*g[c]);
  }else if(key==="tonemap"){
    var mode=Math.round(v); if(mode<=0) return;
    var amt=(v2===undefined?1:v2)*(TONEMAP_GAIN[mode]||1); if(amt===0) return;
    if(mode===5){
      /* AgX real (antes caía en el else y se horneaba como Curva S):
         matriz de entrada + curva log + matriz de salida, con los 3
         canales a la vez —no es una operación por canal—. */
      var l0=bakeLin(cur[0]), l1=bakeLin(cur[1]), l2=bakeLin(cur[2]);
      var r0=AGX_IN[0]*l0+AGX_IN[1]*l1+AGX_IN[2]*l2;
      var g0=AGX_IN[3]*l0+AGX_IN[4]*l1+AGX_IN[5]*l2;
      var b0=AGX_IN[6]*l0+AGX_IN[7]*l1+AGX_IN[8]*l2;
      var ru=agxCurve(c01((Math.log2(Math.max(r0,1e-10))-AGX_MIN_EV)/AGX_RANGE));
      var gu=agxCurve(c01((Math.log2(Math.max(g0,1e-10))-AGX_MIN_EV)/AGX_RANGE));
      var bu=agxCurve(c01((Math.log2(Math.max(b0,1e-10))-AGX_MIN_EV)/AGX_RANGE));
      var ro=AGX_OUT[0]*ru+AGX_OUT[1]*gu+AGX_OUT[2]*bu;
      var go=AGX_OUT[3]*ru+AGX_OUT[4]*gu+AGX_OUT[5]*bu;
      var bo=AGX_OUT[6]*ru+AGX_OUT[7]*gu+AGX_OUT[8]*bu;
      cur[0]=lutC01(cur[0]*(1-amt)+bakeEnc(ro)*amt);
      cur[1]=lutC01(cur[1]*(1-amt)+bakeEnc(go)*amt);
      cur[2]=lutC01(cur[2]*(1-amt)+bakeEnc(bo)*amt);
      return;
    }
    var hw=hableCurve(11.2), fw=filmicCurve(11.2);
    for(c=0;c<3;c++){
      var x=cur[c], lin=bakeLin(x), out;
      if(mode===1){ var hab=Math.max(0, hableCurve(lin*3))/hw, rei=lin/(1+lin)*1.9; out=(bakeEnc(hab)+bakeEnc(rei))/2; }
      else if(mode===2){ out=bakeEnc(acesCurve(lin*1.6)); }
      else if(mode===3){ out=bakeEnc(filmicCurve(lin*3.2)/fw); }
      else { out=sCurve01(x, 0.9); }
      cur[c]=lutC01(x*(1-amt)+out*amt);
    }
  }else if(key==="sat"){
    if(v2===undefined) v2=1; if(v2===1) return;
    var tmpS=new Float32Array(4);
    tmpS[0]=cur[0]*255; tmpS[1]=cur[1]*255; tmpS[2]=cur[2]*255; tmpS[3]=255;
    applySaturationModel(tmpS, v, v2);
    for(c=0;c<3;c++) cur[c]=lutC01(tmpS[c]/255);
  }else if(key==="huesel"){
    if(!v2) return;
    var tmpH=new Float32Array(4);
    tmpH[0]=cur[0]*255; tmpH[1]=cur[1]*255; tmpH[2]=cur[2]*255; tmpH[3]=255;
    applySelectiveHue(tmpH, v, v2);
    for(c=0;c<3;c++) cur[c]=lutC01(tmpH[c]/255);
  }
}
/* Cadena activa del genoma, en orden: pasos de grading y LUTs mezcladas */
function chainStepsOf(genome){
  var steps=[];
  if(!genome) return steps;
  genome.order.forEach(function(key){
    var v=genome.values[key], f=FBY[key];
    if(v===undefined || !f) return;
    if(key.slice(0,3)==="lut"){
      if(v===0) return;
      var id=parseInt(key.slice(3),10);
      if(id>=0 && id<LUTS.length && LUTS[id]) steps.push({lut:id, amt:v});
    }else if(f.key2){
      var arr=geneParams(f, genome.values);
      if(paramsNeutral(key, arr)) return;
      steps.push({key:key, v:arr[0], v2:arr[1], p:arr});
    }else if(key==="exp" || key==="wbk"){
      if(v===f.def) return;
      steps.push({key:key, v:v});
    }
  });
  return steps;
}
function buildBakedLut33(genome){
  var S=LUT_SIZE, steps=chainStepsOf(genome);
  var data=new Float32Array(S*S*S*3), p=0;
  var cur=[0,0,0], smp=[0,0,0];
  for(var bi=0; bi<S; bi++) for(var gi=0; gi<S; gi++) for(var ri=0; ri<S; ri++){
    cur[0]=ri/(S-1); cur[1]=gi/(S-1); cur[2]=bi/(S-1);
    for(var a=0;a<steps.length;a++){
      var st=steps[a];
      if(st.lut!==undefined){
        sampleLutFloat(LUTS[st.lut], cur[0], cur[1], cur[2], smp);
        var amt=st.amt, inv=1-amt;
        cur[0]=lutC01(cur[0]*inv + smp[0]*amt);
        cur[1]=lutC01(cur[1]*inv + smp[1]*amt);
        cur[2]=lutC01(cur[2]*inv + smp[2]*amt);
      }else{
        bakePointStep(cur, st.key, st.v, st.v2, st.p);
      }
    }
    data[p++]=cur[0]; data[p++]=cur[1]; data[p++]=cur[2];
  }
  return data;
}
/* Cadena completa sobre un color flotante, muestreando cada LUT en su
   rejilla de render (65³ si ya se generó; los llamadores de exportación
   la generan antes con ensure65ForGenome). */
function evalChainAt(steps, cur, smp){
  for(var a=0;a<steps.length;a++){
    var st=steps[a];
    if(st.lut!==undefined){
      sampleLutFloat(getRenderLut(st.lut).data, cur[0], cur[1], cur[2], smp);
      var amt=st.amt, inv=1-amt;
      cur[0]=lutC01(cur[0]*inv + smp[0]*amt);
      cur[1]=lutC01(cur[1]*inv + smp[1]*amt);
      cur[2]=lutC01(cur[2]*inv + smp[2]*amt);
    }else{
      bakePointStep(cur, st.key, st.v, st.v2, st.p);
    }
  }
}
/* LUT horneada a 65³: la cadena completa evaluada en los 274625 nodos. */
function buildBakedLut(genome){
  var S=LUT65_SIZE, steps=chainStepsOf(genome);
  var data=new Float32Array(S*S*S*3), p=0;
  var cur=[0,0,0], smp=[0,0,0];
  for(var bi=0; bi<S; bi++) for(var gi=0; gi<S; gi++) for(var ri=0; ri<S; ri++){
    cur[0]=ri/(S-1); cur[1]=gi/(S-1); cur[2]=bi/(S-1);
    evalChainAt(steps, cur, smp);
    data[p++]=cur[0]; data[p++]=cur[1]; data[p++]=cur[2];
  }
  return data;
}
/* Igual que buildBakedLut pero troceado por capas B con setTimeout:
   hornear a 65³ es 7.6× el trabajo del 33³ y no debe bloquear la UI.
   onProgress recibe la fracción 0..1; cb recibe la rejilla 65³. */
function buildBakedLutAsync(genome, onProgress, cb){
  var S=LUT65_SIZE, steps=chainStepsOf(genome);
  var data=new Float32Array(S*S*S*3);
  var cur=[0,0,0], smp=[0,0,0], bi=0;
  function chunk(){
    var end=Math.min(S, bi+4);
    for(; bi<end; bi++){
      var p=((bi*S)*S)*3;
      for(var gi=0; gi<S; gi++) for(var ri=0; ri<S; ri++){
        cur[0]=ri/(S-1); cur[1]=gi/(S-1); cur[2]=bi/(S-1);
        evalChainAt(steps, cur, smp);
        data[p++]=cur[0]; data[p++]=cur[1]; data[p++]=cur[2];
      }
    }
    if(onProgress) onProgress(bi/S);
    if(bi<S) setTimeout(chunk, 0);
    else if(cb) cb(data);
  }
  setTimeout(chunk, 0);
}
function bakedLutBlob(genome, title, prebuilt){
  var data=prebuilt||buildBakedLut(genome), S=LUT65_SIZE, steps=chainStepsOf(genome);
  var parts=['TITLE "'+String(title||"LUT horneada").replace(/"/g,"")+'"',
             "# LUT horneada de Genetic Color Grading: aplicada sola a",
             "# intensidad 1 equivale a aplicar, en este orden:"];
  if(!steps.length) parts.push("#   (sin pasos activos: LUT identidad)");
  steps.forEach(function(st, i){
    if(st.lut!==undefined) parts.push("#   "+(i+1)+". "+lutName(st.lut)+" x "+st.amt.toFixed(4));
    else if(st.key==="exp") parts.push("#   "+(i+1)+". Exposición "+(st.v>0?"+":"")+st.v.toFixed(2)+" EV");
    else if(st.key==="wbk") parts.push("#   "+(i+1)+". Balance de blancos "+Math.round(st.v)+"K");
    else if(st.key==="curves"){ var cp=st.p||[st.v,0,1,1,0,0]; parts.push("#   "+(i+1)+". Contraste y curvas S "+(cp[0]>0?"+":"")+cp[0].toFixed(2)+" · lift "+(cp[1]>0?"+":"")+cp[1].toFixed(2)+" · gamma "+cp[2].toFixed(2)+" · gain "+cp[3].toFixed(2)+" · sombras "+(cp[4]>0?"+":"")+cp[4].toFixed(2)+" · luces "+(cp[5]>0?"+":"")+cp[5].toFixed(2)); }
    else if(st.key==="tonemap") parts.push("#   "+(i+1)+". Tone mapping "+(TONEMAP_NAMES[Math.round(st.v)]||"")+" x "+(st.v2!==undefined?st.v2:1).toFixed(4));
    else if(st.key==="sat") parts.push("#   "+(i+1)+". Saturaci\u00f3n "+(SAT_NAMES[Math.round(st.v)]||"")+" x "+(st.v2!==undefined?st.v2:1).toFixed(4));
    else if(st.key==="huesel") parts.push("#   "+(i+1)+". Hue selectivo "+Math.round(st.v)+"\u00b0 "+(st.v2>0?"+":"")+Math.round(st.v2||0)+"\u00b0");
    else parts.push("#   "+(i+1)+". "+st.key);
  });
  parts.push("LUT_3D_SIZE "+S, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0");
  for(var p=0;p<data.length;p+=3){
    parts.push(data[p].toFixed(6)+" "+data[p+1].toFixed(6)+" "+data[p+2].toFixed(6));
  }
  return new Blob([parts.join("\n")+"\n"],{type:"text/plain;charset=utf-8"});
}
function makeLutButton(idx){
  var b=document.createElement("button");
  b.type="button"; b.className="lut-dl";
  b.title="Descargar esta LUT como archivo .cube.";
  b.setAttribute("aria-label","Descargar "+lutName(idx)+" en formato .cube");
  b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  b.addEventListener("click", function(e){ e.stopPropagation(); downloadLutCube(idx); });
  return b;
}
function showDetail(cellIdx){
  detailCell=cellIdx;
  var g=genomeAtCell(cellIdx);
  if(!g){ return; }
  var popIdx=cellIdx<CENTER_CELL?cellIdx:cellIdx-1;
  detailTitle.textContent= cellIdx===CENTER_CELL ? "Original" : "#"+(popIdx+1);
  detailTitle.title= cellIdx===CENTER_CELL ? "La imagen sin cambios, como referencia." : "";
  detailLineage.textContent=g.lineage||"";
  recipeEl.innerHTML="";
  var diagMap=(typeof transformPanel!=="undefined" && transformPanel && !transformPanel.hidden) ? analyzePipeline(g) : {};
  var shownStep=0;
  g.order.forEach(function(key){
    if(!isAllowedKey(key)) return; /* en Transformaciones solo salen los genes elegidos */
    var i=shownStep++;
    var f=FBY[key], v=g.values[key], noop=(v===f.def && !f.fixed); /* los genes fijos siempre se muestran editables: están siempre presentes */
    var isLut= key.slice(0,3)==="lut";
    var step=document.createElement("div");
    step.dataset.key=key;
    if(noop && !isLut){
      /* Sin efecto y sin slider: solo los genes que no son LUT. Las LUT
         inactivas caen a la rama editable: slider habilitado en 0.00,
         listo para activarse arrastrando. */
      step.className="step noop";
      var sTipNoop=stepTipFor(key); if(sTipNoop) step.title=sTipNoop;
      step.innerHTML='<span class="n">'+(i+1)+'</span><span class="fname">'+f.label+'</span><span class="fval">sin efecto</span>';
      step.appendChild(makeResetButton(cellIdx, g, f, step, null));
      step.appendChild(makePinButton(cellIdx, g, f, step));
      applyStepPinState(step, g, f);
      recipeEl.appendChild(step);
      return;
    }
    step.className="step editable";
    var sTip=stepTipFor(key); if(sTip) step.title=sTip;
    var head=document.createElement("div"); head.className="step-head";
    var headVal=document.createElement("span"); headVal.className="fval";
    function refreshHead(){
      var vv=g.values[key];
      var t=fmtGeneVal(key, vv);
      subGenesOf(f).forEach(function(sg){
        var w2=g.values[sg.gkey];
        t += " · "+(w2!==undefined? fmtGeneVal(sg.gkey, w2):"");
      });
      headVal.textContent=t;
    }
    refreshHead();
    var headTxt=document.createElement("span");
    if(sTip) headTxt.title=sTip;
    headTxt.innerHTML='<span class="n">'+(i+1)+'</span> <span class="fname">'+f.label+'</span>';
    head.appendChild(headTxt); head.appendChild(headVal);
    if(diagMap[key] && diagMap[key].length) head.appendChild(makeWarnEl(diagMap[key]));
    head.appendChild(makeResetButton(cellIdx, g, f, step, refreshHead));
    head.appendChild(makePinButton(cellIdx, g, f, step));
    if(isLut) head.appendChild(makeLutButton(parseInt(key.slice(3),10)));
    step.appendChild(head);
    /* Un slider por cada gen activo de este filtro (el principal y, si el
       filtro lo tiene, su segundo gen), con su valor actual. */
    step.appendChild(makeGeneSlider(cellIdx, g,
      {gkey:f.key, label:f.label, min:f.min, max:f.max, def:f.def},
      f.key2? (f.label1||"Intensidad") : null, refreshHead));
    subGenesOf(f).forEach(function(sg){
      step.appendChild(makeGeneSlider(cellIdx, g,
        {gkey:sg.gkey, label:sg.label, min:sg.min, max:sg.max, def:sg.def},
        sg.label, refreshHead));
    });
    applyStepPinState(step, g, f); /* si el gen está fijado, sliders y restablecer nacen bloqueados */
    recipeEl.appendChild(step);
  });
}


/* ---------- Render de la población ---------- */
function renderThumbInto(canvas, genome){
  var ctx=canvas.getContext("2d");
  var dith=genome? currentDither() : null; /* la original (genome null) nunca lleva dithering */
  if(genome && dith && GPU.renderDithered(workCanvas, TW, TH, genome, canvas, dith)) return;
  if(genome && !dith && GPU.render(workCanvas, TW, TH, genome, ctx)) return;
  ctx.drawImage(workCanvas,0,0);
  if(!genome) return;
  try{
    var data=ctx.getImageData(0,0,TW,TH);
    processGenome(data, genome, dith);
    ctx.putImageData(data,0,0);
  }catch(e){ /* si algo falla, queda la original */ }
}
function renderThumbCpu(canvas, genome){
  /* Miniatura solo por CPU en el hilo principal (sin intentar la GPU):
     cadena float32 de processGenome, con el dithering vigente en su
     única cuantización final si está activado. */
  var ctx=canvas.getContext("2d");
  ctx.drawImage(workCanvas,0,0);
  if(!genome) return;
  try{
    var data=ctx.getImageData(0,0,TW,TH);
    processGenome(data, genome, currentDither());
    ctx.putImageData(data,0,0);
  }catch(e){ /* si algo falla, queda la original */ }
}
function renderPopulation(done){
  if(!source) return;
  if(typeof invalidateHdrThumbs==="function") invalidateHdrThumbs();
  /* Fuera de la fase de genes, la rejilla se renderiza con las rejillas
     65³ de las LUTs de la población: se generan antes (solo las que
     faltan) y el render espera a que estén, sin bloquear la UI. */
  if(!(typeof genePhase!=="undefined" && genePhase) && !renderPopulation._ensuring){
    var miss=[];
    (population||[]).forEach(function(g){
      try{ activeLutsOf(g).forEach(function(a){ if(!hasLut65(a.id) && miss.indexOf(a.id)<0) miss.push(a.id); }); }catch(e){}
    });
    if(miss.length){
      renderPopulation._ensuring=true;
      ensureLuts65(miss, function(){ renderPopulation._ensuring=false; renderPopulation(done); });
      return;
    }
  }
  rendering=true; syncSelectionUI();
  progressEl.style.display="block"; progressBar.style.width="0%";
  statusEl.textContent="Generando…";
  // Centro: original
  var cctx=cellEls[CENTER_CELL].querySelector("canvas").getContext("2d");
  cctx.drawImage(workCanvas,0,0);
  var items=[];
  for(var pi=0; pi<POP_SIZE; pi++){
    var cellIdx=pi<CENTER_CELL?pi:pi+1;
    items.push({ genome:population[pi], canvas:cellEls[cellIdx].querySelector("canvas") });
  }
  var finished=false;
  function finishAll(){
    if(finished) return;
    finished=true;
    rendering=false; progressEl.style.display="none";
    statusEl.textContent=sName+" · "+sW+"×"+sH+" · Gen "+generation;
    syncSelectionUI();
    if(typeof refreshPunishedUI==="function") refreshPunishedUI();
    showPreview(pinnedCell,false);
    if(typeof refreshHdrThumbs==="function") refreshHdrThumbs();
    if(done) done();
  }
  function showProgress(n){
    progressBar.style.width=Math.round(n/POP_SIZE*100)+"%";
    statusEl.textContent="Generando "+n+"/"+POP_SIZE+"…";
  }
  /* CPU de un solo hilo: el bucle clásico, por si todo lo demás falla */
  function singleThread(){
    var idx=0;
    function step(){
      var t0=Date.now();
      while(idx<POP_SIZE && Date.now()-t0<90){
        var cellIdx=idx<CENTER_CELL?idx:idx+1;
        renderThumbInto(cellEls[cellIdx].querySelector("canvas"), population[idx]);
        idx++;
      }
      showProgress(idx);
      if(idx<POP_SIZE){ setTimeout(step, 0); }
      else finishAll();
    }
    setTimeout(step, 30);
  }
  /* CPU en paralelo con el pool de workers; si no arranca, bucle clásico */
  function cpuJobs(jobs, baseCount){
    var base=null;
    try{ base=workCanvas.getContext("2d").getImageData(0,0,TW,TH); }catch(e){}
    if(!base){ jobs.forEach(function(j){ renderThumbCpu(j.canvas, j.genome); }); finishAll(); return; }
    var started=false;
    try{
      started=CpuPool.render(jobs, base, function(n){ showProgress(baseCount+n); }, finishAll, currentDither());
    }catch(e){ started=false; }
    if(!started){
      if(baseCount===0){ singleThread(); return; }
      jobs.forEach(function(j){ renderThumbCpu(j.canvas, j.genome); });
      finishAll();
    }
  }
  function cpuParallel(){ cpuJobs(items, 0); }
  /* GPU: las variantes se encolan en lote y se leen de forma asíncrona;
     las que no tengan ruta GPU (LUT sin float lineal) las hace la CPU */
  if(GPU.ok()){
    var gpuCount=0, cpuItems=[], startedBatch=false;
    try{
      startedBatch=GPU.renderBatchAsync(workCanvas, TW, TH, items, function(it, okItem){
        if(!okItem){ cpuItems.push(it); return; }
        gpuCount++;
        showProgress(gpuCount);
      }, function(){
        if(!cpuItems.length){ finishAll(); return; }
        cpuJobs(cpuItems, gpuCount);
      }, currentDither());
    }catch(e){ startedBatch=false; }
    if(startedBatch) return;
    /* El lote no pudo arrancar: todo a CPU en paralelo */
    cpuParallel();
    return;
  }
  cpuParallel();
}

/* ---------- Fase de elegir genes ----------
   Al subir una imagen, antes de la primera generación, se muestran
   todas las LUTs (73 en este clon Top 75) aplicadas cada una a
   su potencia de arranque: su potencia máxima segura, es decir, la
   potencia a la que un 1% más ya activaría algún indicador activo
   de Límites seguros para ESTA imagen (búsqueda binaria con el
   mismo diagnóstico de 96 px de la criba; si ni al 100% se activa
   ninguno, la referencia es el 100%). Esa potencia máxima segura
   queda guardada en geneSafePower y la de la preview en
   geneIntensity. Bajo cada imagen hay un slider para ajustar la
   potencia de esa vista previa a mano, y el checkbox «Previews al
   100%» de la cabecera pasa todas las previews al 100% o las
   devuelve a su potencia máxima segura (solo previews: la
   selección de genes y la evolución no cambian). El usuario marca
   las que le gustan y solo esas quedan como genes posibles para
   toda la evolución (allowedSet). */
var genePhase=false, geneSelected={}, geneCellEls=[];
var geneIntensity={}, geneSafePower={}, genePowerEls={}, geneComputeToken=0;
/* Filtro de potencia mínima: umbral (0–1) sobre la potencia de disparo
   (geneSafePower) y conjunto de índices ocultos SOLO por este filtro.
   A diferencia del filtro de familias, que retira la tarjeta del DOM,
   este oculta con display:none para poder mostrarla de nuevo al bajar
   el umbral: es en vivo y reversible dentro de la misma imagen. */
var geneMinPower=0, geneMinPowerHidden={};
var geneMinPowerEl=document.getElementById("sGeneMinPower"), geneMinPowerValEl=document.getElementById("vGeneMinPower");
var genePhaseEl=document.getElementById("genePhase"), geneGridEl=document.getElementById("geneGrid"),
    customGeneGridEl=document.getElementById("customGeneGrid"), customLutsTitleEl=document.getElementById("customLutsTitle"),
    genePreviews100El=document.getElementById("chkGenePreviews100"),
    btnStartEv=document.getElementById("btnStartEvolution"), btnStartEv2=document.getElementById("btnStartEvolution2"),
    btnStartEvFloat=document.getElementById("btnStartEvolutionFloat"),
    stageLayoutEl2=document.getElementById("stageLayout");
function singleLutGenome(idx, inten){
  var values={};
  GENES.forEach(function(g){ values[g.gkey]=g.def; });
  var v=(inten!==undefined && inten!==null) ? inten : (geneIntensity[idx]!==undefined ? geneIntensity[idx] : 0.5);
  values["lut"+idx]=v;
  return { values:values, order:CANON.slice(), kind:"gen", lineage:"LUT al "+Math.round(v*100)+"% (preview)" };
}
/* ¿Activaría esta LUT sola, a esta intensidad, algún indicador activo
   para la imagen cargada? Mismo diagnóstico que la criba de Límites
   seguros, a 96 px. Sin imagen o sin indicadores activos, nunca. */
function lutTriggersAt(idx, inten){
  if(!TW || !TH || !workCanvas || !workCanvas.width) return false;
  var d=analyzePipelineDetailed(singleLutGenome(idx, inten), 96);
  for(var k in d.ids){ if(Object.prototype.hasOwnProperty.call(d.ids, k)) return true; }
  return false;
}
/* Potencia máxima segura de una LUT (su potencia de disparo): la
   mayor potencia a la que todavía no se activa ningún indicador;
   un 1% más ya activaría alguno. Búsqueda binaria con resolución
   del 1%: «lo» queda como la mayor potencia segura en pasos de 1%
   (a lo+1% ya dispara). Si ni al 100% se activa ninguno, es 1. */
function geneStartIntensity(idx){
  if(!lutTriggersAt(idx, 1)) return 1;
  var lo=0, hi=1;
  while(hi-lo>0.01){
    var mid=(lo+hi)/2;
    if(lutTriggersAt(idx, mid)) hi=mid; else lo=mid;
  }
  return lo;
}
/* Fila de potencia bajo cada imagen de gen: slider 0–100% que ajusta
   solo la vista previa de esa LUT. Queda deshabilitado hasta que se
   calcula la potencia de arranque. */
function makeGenePowerRow(idx, canvas){
  var row=document.createElement("div"); row.className="gene-power";
  var lab=document.createElement("span"); lab.className="gp-label"; lab.textContent="Potencia";
  var slider=document.createElement("input"); slider.type="range";
  slider.min="0"; slider.max="100"; slider.step="1"; slider.value="50"; slider.disabled=true;
  slider.setAttribute("aria-label","Potencia de la vista previa de esta LUT");
  slider.title="Ajusta solo la vista previa de esta LUT; no cambia la evolución";
  var val=document.createElement("span"); val.className="gp-val"; val.textContent="…";
  row.appendChild(lab); row.appendChild(slider); row.appendChild(val);
  var timer=null;
  slider.addEventListener("input", function(){
    var v=parseInt(slider.value, 10);
    if(isNaN(v)) return;
    /* Ajuste individual con «Previews al 100%» marcado: solo cambia
       esta preview y el checkbox se desmarca, sin tocar a las demás
       (se desmarca por código, sin disparar su evento change, que
       sí devolvería todas a su potencia máxima segura). */
    if(genePreviews100El && genePreviews100El.checked) genePreviews100El.checked=false;
    geneIntensity[idx]=v/100;
    val.textContent=v+"%";
    if(timer) clearTimeout(timer);
    timer=setTimeout(function(){ timer=null; renderGeneThumbCpu(canvas, singleLutGenome(idx)); }, 120);
  });
  genePowerEls[idx]={ slider:slider, val:val, canvas:canvas };
  return row;
}
function setGenePowerUI(idx){
  var ui=genePowerEls[idx]; if(!ui) return;
  var pct=Math.round((geneIntensity[idx]!==undefined ? geneIntensity[idx] : 0.5)*100);
  ui.slider.value=String(pct); ui.slider.disabled=false;
  ui.val.textContent=pct+"%";
}
/* Checkbox «Previews al 100%» de la cabecera: al marcarlo, todas las
   previews con tarjeta (incluidas y propias) pasan al 100% y sus
   sliders lo muestran; al desmarcarlo a mano, todas vuelven a su
   potencia máxima segura (geneSafePower). Solo previews: no toca
   potencias de disparo, orden, selección ni evolución. */
function applyGenePreviews100(){
  var to100=!!(genePreviews100El && genePreviews100El.checked);
  var items=[];
  Object.keys(genePowerEls).forEach(function(k){
    var idx=parseInt(k, 10), ui=genePowerEls[idx];
    if(!ui || !ui.canvas) return;
    geneIntensity[idx]= to100 ? 1 : (geneSafePower[idx]!==undefined ? geneSafePower[idx] : geneIntensity[idx]);
    setGenePowerUI(idx);
    items.push({ genome:singleLutGenome(idx), canvas:ui.canvas });
  });
  if(items.length) renderGeneThumbs(items);
}
if(genePreviews100El) genePreviews100El.addEventListener("change", applyGenePreviews100);
/* Filtro de potencia mínima (slider «Potencia mínima» de la cabecera):
   se aplica DESPUÉS del filtro de familias, solo sobre las tarjetas
   que lo sobrevivieron (las ocultas por familia ya no están en el DOM
   ni en geneCellEls, así que este filtro nunca las toca ni las trae de
   vuelta). Muestra solo los genes cuya potencia de disparo
   (geneSafePower, NO la potencia actual de la preview) sea mayor o
   igual que el umbral. Al ocultar un gen se le quita la selección: no
   se puede elegir mientras está oculto ni entra en la evolución de
   esta imagen, igual que los ocultos por familia. Al bajar el umbral,
   los ocultos por potencia reaparecen al momento. */
function applyMinPowerFilter(){
  Object.keys(geneCellEls).forEach(function(k){
    var idx=parseInt(k, 10), el=geneCellEls[idx];
    if(!el) return;
    var p=geneSafePower[idx];
    if(typeof p!=="number" || !isFinite(p)) return;
    var wrap=el.parentNode;
    if(p < geneMinPower-1e-9){
      if(!geneMinPowerHidden[idx]){
        geneMinPowerHidden[idx]=true;
        if(geneSelected[idx]){ delete geneSelected[idx]; el.setAttribute("aria-pressed","false"); }
      }
      if(wrap) wrap.style.display="none";
    }else{
      if(geneMinPowerHidden[idx]) delete geneMinPowerHidden[idx];
      if(wrap) wrap.style.display="";
    }
  });
  renumberGeneCards();
  updateCustomSectionVisibility();
  syncGeneUI();
}
if(geneMinPowerEl) geneMinPowerEl.addEventListener("input", function(){
  var v=parseInt(geneMinPowerEl.value, 10);
  if(isNaN(v)) v=0;
  geneMinPower=v/100;
  if(geneMinPowerValEl) geneMinPowerValEl.textContent=v+"%";
  applyMinPowerFilter();
});
/* Al empezar la fase con una imagen nueva el slider vuelve a 0%
   mientras se calculan las potencias; en cuanto están y el filtro
   de familias ha pasado, autoAdjustGeneMinPower() lo deja en el
   umbral de la mitad de supervivientes. Mientras se sigue en la
   misma imagen conserva el valor que tenga (autoajustado o movido
   a mano): añadir LUTs propias NO lo vuelve a autoajustar. */
function resetGeneMinPower(){
  geneMinPower=0; geneMinPowerHidden={};
  if(geneMinPowerEl){ geneMinPowerEl.value="0"; geneMinPowerEl.disabled=false; }
  if(geneMinPowerValEl) geneMinPowerValEl.textContent="0%";
}
/* Autoajuste del slider «Potencia mínima» al empezar la fase de
   genes con una imagen nueva: se toman las potencias de disparo
   (geneSafePower) de los genes que sobrevivieron al filtro de
   familias (los que siguen en geneCellEls), ordenadas de mayor a
   menor; con n supervivientes, k = ceil(n/2) y el umbral es la
   potencia del k-ésimo en ese orden. Como el filtro muestra los de
   potencia mayor o igual que el umbral, quedan visibles justo la
   mitad (redondeada hacia arriba), y si hay empates en el valor
   límite se muestran todos los empatados. El umbral interno es la
   potencia exacta; el slider y su % muestran ese valor redondeado
   al % entero que el control admite. Solo se llama desde el arranque
   de la fase (computeGeneStartIntensities), nunca al añadir LUTs
   propias durante la fase. */
function autoAdjustGeneMinPower(){
  var powers=[];
  Object.keys(geneCellEls).forEach(function(k){
    var p=geneSafePower[parseInt(k, 10)];
    if(typeof p==="number" && isFinite(p)) powers.push(p);
  });
  if(!powers.length) return;
  powers.sort(function(a, b){ return b-a; });
  var threshold=powers[Math.ceil(powers.length/2)-1];
  geneMinPower=threshold;
  var pct=Math.round(threshold*100);
  if(geneMinPowerEl) geneMinPowerEl.value=String(pct);
  if(geneMinPowerValEl) geneMinPowerValEl.textContent=pct+"%";
}
function syncGeneUI(){
  var n=Object.keys(geneSelected).length;
  btnStartEv.disabled= n===0;
  btnStartEv2.disabled= n===0;
  /* Botón flotante: visible solo en fase de genes con ≥1 LUT elegida. */
  if(btnStartEvFloat) btnStartEvFloat.hidden= !(genePhase && n>0);
}
function toggleGene(idx){
  if(geneMinPowerHidden[idx]) return; /* oculto por potencia mínima: no se puede elegir */
  if(typeof monoHiddenSet!=="undefined" && monoHiddenSet[idx]) return; /* oculto por monótono: no se puede elegir */
  if(typeof geneHiddenSet!=="undefined" && geneHiddenSet[idx]) return; /* oculto por familia: no se puede elegir */
  if(geneSelected[idx]) delete geneSelected[idx]; else geneSelected[idx]=true;
  geneCellEls[idx].setAttribute("aria-pressed", geneSelected[idx]?"true":"false");
  syncGeneUI();
}
function renderGeneThumbCpu(canvas, genome){
  /* Miniatura de gen solo por CPU, desde la copia grande (geneWork):
     cadena float32 con el dithering vigente en la cuantización final. */
  var ctx=canvas.getContext("2d");
  ctx.drawImage(geneWork,0,0);
  if(!genome) return;
  try{
    var data=ctx.getImageData(0,0,GW,GH);
    processGenome(data, genome, currentDither());
    ctx.putImageData(data,0,0);
  }catch(e){ /* si algo falla, queda la original */ }
}
function renderGeneThumbs(items){
  rendering=true; syncSelectionUI();
  progressEl.style.display="block"; progressBar.style.width="0%";
  statusEl.textContent="Generando LUTs…";
  var doneN=0, finished=false;
  function prog(){
    doneN++;
    progressBar.style.width=Math.round(doneN/items.length*100)+"%";
    statusEl.textContent="Generando "+doneN+"/"+items.length+" LUTs…";
  }
  function fin(){
    if(finished) return;
    finished=true; rendering=false; progressEl.style.display="none";
    statusEl.textContent="Elige tus LUTs.";
    syncSelectionUI();
  }
  function cpuChunk(list, next){
    var idx=0;
    function step(){
      var t0=Date.now();
      while(idx<list.length && Date.now()-t0<90){
        renderGeneThumbCpu(list[idx].canvas, list[idx].genome);
        prog(); idx++;
      }
      if(idx<list.length) setTimeout(step, 0);
      else if(next) next(); else fin();
    }
    setTimeout(step, 30);
  }
  /* GPU por lotes de 20: a esta resolución, encolar las 73 cadenas a la
     vez retendría demasiadas texturas grandes en memoria. */
  var CHUNK=20;
  function gpuFrom(idx){
    if(idx>=items.length){ fin(); return; }
    if(!GPU.ok()){ cpuChunk(items.slice(idx), null); return; }
    var slice=items.slice(idx, idx+CHUNK), cpuItems=[], started=false;
    try{
      started=GPU.renderBatchAsync(geneWork, GW, GH, slice, function(it, okItem){
        if(!okItem){ cpuItems.push(it); return; }
        prog();
      }, function(){
        var adv=function(){ gpuFrom(idx+slice.length); };
        if(cpuItems.length) cpuChunk(cpuItems, adv); else adv();
      }, currentDither());
    }catch(e){ started=false; }
    if(!started) cpuChunk(items.slice(idx), null);
  }
  gpuFrom(0);
}
function startGenePhase(){
  resetGenePins(); /* imagen nueva: los pins de la sesión anterior se limpian y Hue vuelve a nacer fijado en 0, 0 */
  genePhase=true; geneSelected={}; allowedSet=null;
  geneIntensity={}; geneSafePower={}; genePowerEls={};
  resetGeneMinPower();
  if(genePreviews100El) genePreviews100El.checked=false;
  geneHiddenSet={}; geneHiddenCount=0;
  geneDetached={};
  monoHiddenSet={}; monoHiddenCount=0;
  monoMetricsCache={}; monoOrigMetrics=null; monoBaseCache=null;
  if(typeof compassNewImage==="function") compassNewImage();
  MONO_INDICATORS.forEach(function(ind){ monoKills[ind.id]=0; });
  updateMonoKillUI();
  if(typeof syncMonoPanelState==="function") syncMonoPanelState();
  generation=0; genBadge.textContent="Gen 0";
  selected={}; detailCell=-1;
  cellEls.forEach(function(el){ el.setAttribute("aria-pressed","false"); });
  syncSelectionUI();
  if(stageLayoutEl2) stageLayoutEl2.style.display="none";
  genePhaseEl.hidden=false;
  geneGridEl.innerHTML=""; if(customGeneGridEl) customGeneGridEl.innerHTML=""; geneCellEls=[];
  var pending=[];
  /* Tus LUTs primero, en su sección, CON nombre y en su orden. */
  var customIdxs=[];
  for(var ci=0; ci<LUTS.length; ci++){ var cu0=CUSTOM_BY_IDX[ci]; if(cu0 && !cu0.removed) customIdxs.push(ci); }
  customIdxs.forEach(function(idx){
    var c=makeCustomGeneCell(idx);
    customGeneGridEl.appendChild(c.wrap);
    geneCellEls[idx]=c.btn;
    pending.push({ idx:idx, canvas:c.canvas });
  });
  updateCustomSectionVisibility();
  /* Los incluidos: sin nombres y en orden aleatorio (Fisher-Yates en cada
     fase) para evitar sesgo humano: el número visible es la posición en
     pantalla, no el índice del catálogo, y la etiqueta accesible tampoco
     revela qué LUT es. geneCellEls sigue indexado por LUT real para que la
     selección y los botones Todos/Ninguno no cambien. El orden aleatorio
     es solo el de partida: al terminar el cálculo de potencias,
     sortGeneCards() reordena por potencia de disparo descendente (los
     empates conservan este orden aleatorio). */
  var order=[];
  for(var i=0;i<LUTS.length;i++){ if(!CUSTOM_BY_IDX[i]) order.push(i); }
  order=shuffled(order);
  order.forEach(function(idx, pos){
    var wrap=document.createElement("div"); wrap.className="gene-wrap";
    wrap.dataset.lutIdx=idx;
    var b=document.createElement("button");
    b.type="button"; b.className="gene-cell";
    b.setAttribute("aria-pressed","false");
    b.setAttribute("aria-label", "Opción "+(pos+1)+". Toca para elegirla como gen.");
    var cv=document.createElement("canvas"); cv.width=GW; cv.height=GH;
    b.appendChild(cv);
    var num=document.createElement("span"); num.className="gnum"; num.textContent="#"+(pos+1);
    b.appendChild(num);
    var chk=document.createElement("span"); chk.className="check";
    chk.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    b.appendChild(chk);
    b.addEventListener("click", function(){ toggleGene(idx); });
    wrap.appendChild(b);
    wrap.appendChild(makeGenePowerRow(idx, cv));
    geneGridEl.appendChild(wrap);
    geneCellEls[idx]=b;
    pending.push({ idx:idx, canvas:cv });
  });
  syncGeneUI();
  computeGeneStartIntensities(pending);
}
/* Ordena las tarjetas de genes por potencia de disparo descendente:
   primero las LUTs que aguantan más potencia antes de que un 1% más
   active un indicador de Límites seguros (más rango para jugar). Se
   ordena por geneSafePower (la potencia de disparo guardada), no
   por la potencia de la preview, así que ni el slider ni el
   checkbox «Previews al 100%» pueden cambiar este orden. Las que
   no disparan ni al 100% quedan con la potencia máxima y van
   primero. Empates: se conserva el orden actual de la tarjeta. Solo
   cambia el orden en pantalla; la selección ciega se mantiene (las
   incluidas siguen sin nombre y su número/etiqueta se renumera a la
   nueva posición). */
function sortGeneGrid(gridEl, renumber){
  if(!gridEl) return;
  var wraps=Array.prototype.slice.call(gridEl.children);
  var decorated=wraps.map(function(w, i){
    var idx=parseInt(w.dataset.lutIdx, 10);
    var v=(geneSafePower[idx]!==undefined) ? geneSafePower[idx] : geneIntensity[idx];
    return { w:w, i:i, p:(typeof v==="number" && isFinite(v)) ? v : -1 };
  });
  decorated.sort(function(a, b){ return (b.p - a.p) || (a.i - b.i); });
  decorated.forEach(function(d, pos){
    gridEl.appendChild(d.w);
    if(renumber){
      var num=d.w.querySelector(".gnum");
      if(num) num.textContent="#"+(pos+1);
      var btn=d.w.querySelector(".gene-cell");
      if(btn) btn.setAttribute("aria-label", "Opción "+(pos+1)+". Toca para elegirla como gen.");
    }
  });
}
function sortGeneCards(){
  sortGeneGrid(geneGridEl, true);
  sortGeneGrid(customGeneGridEl, false);
}
/* ---------- Filtro de familias por similitud (por imagen) ----------
   Sin grupos fijos ni nada persistido sobre familias: en cada fase de
   genes, con las tarjetas ya ordenadas por potencia de disparo
   descendente para ESTA imagen, se recorre la lista de arriba hacia
   abajo y cada LUT que se queda (campeona) elimina a todas las que
   estén a distancia SIMILARITY_THRESHOLD o menos de ella; la siguiente
   superviviente elimina a las suyas, y así sucesivamente. Al final
   queda la mejor LUT de cada familia para esta imagen. Las eliminadas
   no aparecen como tarjetas y no entran en la evolución de esta
   imagen.
   Firma de una LUT: la LUT aplicada al 100% sobre una rejilla fija de
   729 colores (9×9×9, valores 0, 1/8, …, 1 por canal), muestreada con
   la misma interpolación trilineal de siempre y guardada en escala
   0-255. Distancia entre dos LUTs: diferencia media absoluta por
   canal entre sus firmas. Solo se comparan LUTs entre sí (incluidas
   las propias del usuario, que también tienen firma); los genes
   tradicionales no tienen firma: no eliminan a nadie ni son
   eliminados por este mecanismo. */
var SIMILARITY_THRESHOLD=15.5;
var lutSignatures={}, geneHiddenSet={}, geneHiddenCount=0;
function lutSignature(idx){
  if(lutSignatures[idx]) return lutSignatures[idx];
  var data=LUTS[idx]; if(!data) return null;
  var sig=new Float32Array(9*9*9*3), out=[0,0,0], p=0;
  for(var bi=0; bi<9; bi++) for(var gi=0; gi<9; gi++) for(var ri=0; ri<9; ri++){
    sampleLutSrc(data, LUT_SIZE, ri/8, gi/8, bi/8, out);
    sig[p++]=out[0]*255; sig[p++]=out[1]*255; sig[p++]=out[2]*255;
  }
  lutSignatures[idx]=sig;
  return sig;
}
function lutSignatureDistance(sa, sb){
  var sum=0;
  for(var i=0;i<sa.length;i++){ var d=sa[i]-sb[i]; sum+= d<0 ? -d : d; }
  return sum/sa.length;
}
/* Tarjetas retiradas por monótonos o por familias: su wrap se guarda
   aquí (con su botón y su fila de potencia) para que «Volver a
   filtrar» pueda reconstruir el conjunto completo sin recalcular
   potencias ni perder las vistas previas ya generadas. */
var geneDetached={};
function stashGeneCard(idx){
  if(geneDetached[idx]) return;
  var el=geneCellEls[idx];
  if(!el) return;
  var wrap=el.parentNode;
  geneDetached[idx]={ wrap:wrap, btn:el, power:(genePowerEls[idx]||null),
    isCustom:!!(wrap && wrap.parentNode && customGeneGridEl && wrap.parentNode===customGeneGridEl) };
}
function detachGeneCard(idx){
  stashGeneCard(idx);
  if(geneSelected[idx]) delete geneSelected[idx];
  delete geneMinPowerHidden[idx];
  delete genePowerEls[idx];
  var el=geneCellEls[idx];
  delete geneCellEls[idx];
  if(!el) return;
  var wrap=el.parentNode;
  if(wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
  else if(el.parentNode) el.parentNode.removeChild(el);
}
function hideGeneCard(idx){
  geneHiddenSet[idx]=true;
  detachGeneCard(idx);
}
function restoreAllGeneCards(){
  Object.keys(geneDetached).forEach(function(k){
    var idx=parseInt(k, 10), rec=geneDetached[idx];
    if(!rec) return;
    delete geneDetached[idx];
    if(!rec.wrap || !rec.btn) return;
    var grid=rec.isCustom ? customGeneGridEl : geneGridEl;
    if(grid) grid.appendChild(rec.wrap);
    rec.wrap.style.display="";
    geneCellEls[idx]=rec.btn;
    if(rec.power) genePowerEls[idx]=rec.power;
  });
  geneHiddenSet={}; geneHiddenCount=0;
  if(typeof monoHiddenSet!=="undefined"){ monoHiddenSet={}; monoHiddenCount=0; }
  geneMinPowerHidden={};
  Object.keys(geneCellEls).forEach(function(k){
    var el=geneCellEls[parseInt(k, 10)];
    if(el && el.parentNode) el.parentNode.style.display="";
  });
}
function renumberGeneCards(){
  if(!geneGridEl) return;
  var pos=0;
  Array.prototype.forEach.call(geneGridEl.children, function(w){
    var idx=parseInt(w.dataset.lutIdx, 10);
    if(geneMinPowerHidden[idx]) return; /* oculto por potencia mínima: no ocupa número */
    pos++;
    var num=w.querySelector(".gnum"); if(num) num.textContent="#"+pos;
    var btn=w.querySelector(".gene-cell");
    if(btn) btn.setAttribute("aria-label", "Opción "+pos+". Toca para elegirla como gen.");
  });
}
/* Recorrido voraz de campeón sobre todas las tarjetas LUT presentes
   (incluidas y propias juntas, en una sola lista), en orden de
   potencia de disparo descendente. Devuelve los índices ocultados en
   esta pasada. Las LUTs sin potencia calculada todavía no participan:
   ni eliminan ni son eliminadas. */
function applySimilarityFilter(){
  var ordered=[];
  [customGeneGridEl, geneGridEl].forEach(function(grid){
    if(!grid) return;
    Array.prototype.forEach.call(grid.children, function(w){
      var idx=parseInt(w.dataset.lutIdx, 10);
      if(!isNaN(idx) && ordered.indexOf(idx)<0) ordered.push(idx);
    });
  });
  var decorated=ordered.map(function(idx, i){
    /* El recorrido va por potencia de disparo (geneSafePower), no
       por la potencia de la preview: sliders y checkbox no cuentan. */
    var v=(geneSafePower[idx]!==undefined) ? geneSafePower[idx] : geneIntensity[idx];
    return { idx:idx, i:i, p:(typeof v==="number" && isFinite(v)) ? v : null };
  }).filter(function(d){ return d.p!==null; });
  decorated.sort(function(a, b){ return (b.p-a.p) || (a.i-b.i); });
  var champions=[], hidden=[];
  decorated.forEach(function(d){
    var sig=lutSignature(d.idx);
    if(!sig) return; /* sin firma: ni elimina ni es eliminada */
    var dup=false;
    for(var c=0; c<champions.length; c++){
      if(lutSignatureDistance(sig, champions[c])<=SIMILARITY_THRESHOLD){ dup=true; break; }
    }
    if(dup) hidden.push(d.idx); else champions.push(sig);
  });
  hidden.forEach(hideGeneCard);
  geneHiddenCount+=hidden.length;
  renumberGeneCards();
  updateCustomSectionVisibility();
  return hidden;
}
/* ---------- Filtro de monótonos (por imagen, antes que familias) ----------
   Cada indicador compara, a 96 px, la imagen original con la imagen
   con la LUT aplicada a su potencia de disparo (geneSafePower) y mide
   cuánto AUMENTA la monotonía. Una LUT muere si falla cualquiera de
   los indicadores activos; si falla varios, cada uno suma +1 a su
   conteo de LUTs eliminadas. Las métricas por LUT se cachean por
   imagen (monoMetricsCache) y las de la original una sola vez
   (monoOrigMetrics), así que «Volver a filtrar» solo reevalúa los
   umbrales contra la caché. Este filtro va PRIMERO en el pipeline:
   una LUT potente pero monótona no debe convertirse en campeona de
   su familia y matar a familiares con colores más ricos. */
var MONO_INDICATORS=[
  {id:"hueEntropy", label:"Entropía de tono", thrLabel:"Caída", min:0, max:0.50, step:0.01, def:0.02, fmt:function(v){return v.toFixed(2);}},
  {id:"distinct", label:"Colores distintos", thrLabel:"Pérdida", min:0, max:80, step:1, def:30, fmt:function(v){return Math.round(v)+"%";}},
  {id:"abSpread", label:"Extensión a*b*", thrLabel:"Caída", min:0, max:80, step:1, def:25, fmt:function(v){return Math.round(v)+"%";}},
  {id:"colorfulness", label:"Colorfulness", thrLabel:"Caída", min:0, max:80, step:1, def:30, fmt:function(v){return Math.round(v)+"%";}},
  {id:"meanSat", label:"Saturación media", thrLabel:"Caída", min:0, max:0.50, step:0.01, def:0.05, fmt:function(v){return v.toFixed(2);}},
  {id:"dominant", label:"Color dominante", thrLabel:"Subida", min:0, max:50, step:0.5, def:1.5, fmt:function(v){return (v%1===0? Math.round(v) : v.toFixed(1))+"%";}},
  {id:"localVar", label:"Variedad local", thrLabel:"Caída", min:0, max:80, step:1, def:6, fmt:function(v){return Math.round(v)+"%";}}
];
var MONO_BY_ID={}, monoEnabled={}, monoThresholds={}, monoKills={};
MONO_INDICATORS.forEach(function(ind){
  MONO_BY_ID[ind.id]=ind; monoEnabled[ind.id]=true; monoThresholds[ind.id]=ind.def; monoKills[ind.id]=0;
});
var monoMasterOn=true, monoHiddenSet={}, monoHiddenCount=0;
var monoMetricsCache={}, monoOrigMetrics=null, monoBaseCache=null;
var monoMasterEl=document.getElementById("chkMonoMaster"),
    monoPanelEl=document.getElementById("monoPanel"),
    btnRefilterEl=document.getElementById("btnRefilter");
function monoOn(id){ return monoEnabled[id]!==false; }
function monoThr(id){ var v=monoThresholds[id]; return (v===undefined||v===null) ? MONO_BY_ID[id].def : v; }
/* Posición del slider <-> umbral real, invertida: a la derecha (posición
   máxima) el umbral es 0 (más estricto, mata a todo gen que empeore el
   indicador) y a la izquierda (posición mínima) el umbral es el máximo
   adaptativo (más permisivo, no mata nada). El número mostrado sigue
   siendo el umbral real (la caída permitida), así que baja al mover a
   la derecha. El degradado del slider ya va de pálido a la izquierda a
   naranja intenso a la derecha, acorde con esta dirección. */
function monoSliderPos(ind, real){ return Number((ind.min+ind.max-real).toFixed(4)); }
function monoRealFromPos(ind, pos){ return Number((ind.min+ind.max-pos).toFixed(4)); }
function updateMonoKillUI(){
  MONO_INDICATORS.forEach(function(ind){
    var el=document.getElementById("monoKill-"+ind.id);
    if(el) el.textContent=String(monoKills[ind.id]||0);
  });
}
function syncMonoPanelState(){
  var on=!!(monoMasterEl && monoMasterEl.checked);
  monoMasterOn=on;
  if(monoPanelEl) monoPanelEl.classList.toggle("is-off", !on);
  MONO_INDICATORS.forEach(function(ind){
    var chk=document.getElementById("monoChk-"+ind.id);
    var slider=document.getElementById("monoThr-"+ind.id);
    var row=document.getElementById("monoRow-"+ind.id);
    var indOn=monoOn(ind.id);
    if(chk) chk.disabled=!on;
    if(slider) slider.disabled=(!on || !indOn);
    if(row) row.classList.toggle("is-off", !indOn);
  });
}
function buildMonoPanel(){
  var list=document.getElementById("monoList");
  if(!list || list.children.length) return;
  MONO_INDICATORS.forEach(function(ind){
    var row=document.createElement("div"); row.className="mono-row"; row.id="monoRow-"+ind.id;
    var main=document.createElement("div"); main.className="mono-row-main";
    var lab=document.createElement("label"); lab.setAttribute("for","monoChk-"+ind.id);
    var chk=document.createElement("input"); chk.type="checkbox"; chk.id="monoChk-"+ind.id; chk.checked=true;
    chk.setAttribute("aria-label","Activar indicador "+ind.label);
    var name=document.createElement("span"); name.textContent=ind.label;
    lab.appendChild(chk); lab.appendChild(name);
    var kill=document.createElement("span"); kill.className="mono-kill"; kill.id="monoKill-"+ind.id; kill.textContent="0";
    kill.title="LUTs eliminadas por "+ind.label+" en el último filtrado";
    main.appendChild(lab); main.appendChild(kill);
    row.appendChild(main);
    var sliderRow=document.createElement("div"); sliderRow.className="mono-slider";
    var thrLab=document.createElement("span"); thrLab.className="mono-thr-label"; thrLab.textContent=ind.thrLabel;
    var slider=document.createElement("input"); slider.type="range"; slider.id="monoThr-"+ind.id;
    slider.min=String(ind.min); slider.max=String(ind.max); slider.step=String(ind.step); slider.value=String(monoSliderPos(ind, ind.def));
    slider.setAttribute("aria-label","Umbral de "+ind.label+" (a la derecha, más estricto)");
    slider.setAttribute("aria-valuetext", ind.fmt(ind.def));
    slider.title="A la derecha: filtro más estricto · El valor mostrado es el umbral real";
    var thrVal=document.createElement("span"); thrVal.className="mono-thr-val"; thrVal.id="monoThrVal-"+ind.id; thrVal.textContent=ind.fmt(ind.def);
    sliderRow.appendChild(thrLab); sliderRow.appendChild(slider); sliderRow.appendChild(thrVal);
    row.appendChild(sliderRow);
    list.appendChild(row);
    /* Checkbox y slider solo actualizan el estado: el filtrado se
       aplica al pulsar «Volver a filtrar» o al subir una imagen. */
    chk.addEventListener("change", function(){
      monoEnabled[ind.id]=!!chk.checked;
      syncMonoPanelState();
    });
    slider.addEventListener("input", function(){
      var pos=parseFloat(slider.value);
      if(!isNaN(pos)){ var v=monoRealFromPos(ind, pos); monoThresholds[ind.id]=v; thrVal.textContent=ind.fmt(v); slider.setAttribute("aria-valuetext", ind.fmt(v)); }
    });
  });
  if(monoMasterEl) monoMasterEl.addEventListener("change", syncMonoPanelState);
  if(btnRefilterEl) btnRefilterEl.addEventListener("click", function(){ refilterGenes(); });
  syncMonoPanelState();
  updateMonoKillUI();
}
buildMonoPanel();
var monoWorkCanvas=document.createElement("canvas");
function monoBase96(){
  if(monoBaseCache) return monoBaseCache;
  if(!workCanvas || !workCanvas.width || !TW || !TH) return null;
  var sc=Math.min(96/TW, 96/TH, 1);
  var aw=Math.max(8, Math.round(TW*sc)), ah=Math.max(8, Math.round(TH*sc));
  monoWorkCanvas.width=aw; monoWorkCanvas.height=ah;
  var ctx=monoWorkCanvas.getContext("2d");
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high";
  ctx.drawImage(workCanvas, 0, 0, aw, ah);
  var img=null;
  try{ img=ctx.getImageData(0, 0, aw, ah); }catch(e){ return null; }
  monoBaseCache={ data:img.data, w:aw, h:ah };
  return monoBaseCache;
}
function computeMonoMetrics(data, w, h){
  var npix=w*h;
  var hueHist=new Float64Array(36), hueCount=0;
  var distinctArr=new Uint8Array(4096), domCounts=new Uint32Array(4096);
  var sumSat=0, sumA=0, sumB=0, sumA2=0, sumB2=0;
  var sumRG=0, sumYB=0, sumRG2=0, sumYB2=0;
  var hsv=[0,0,0];
  for(var i=0;i<data.length;i+=4){
    var r=data[i], g=data[i+1], b=data[i+2];
    rgbToHsv01(r/255, g/255, b/255, hsv);
    sumSat+=hsv[1];
    if(hsv[1]>=0.1){
      var bin=Math.floor(hsv[0]/10); if(bin<0) bin=0; if(bin>35) bin=35;
      hueHist[bin]++; hueCount++;
    }
    var q=(((r>>4)<<8)|((g>>4)<<4)|(b>>4));
    distinctArr[q]=1; domCounts[q]++;
    var Rl=srgbLin(r), Gl=srgbLin(g), Bl=srgbLin(b);
    var X=(0.4124564*Rl + 0.3575761*Gl + 0.1804375*Bl)*100;
    var Y=(0.2126729*Rl + 0.7151522*Gl + 0.0721750*Bl)*100;
    var Z=(0.0193339*Rl + 0.1191920*Gl + 0.9503041*Bl)*100;
    var fx=labF(X/XN), fy=labF(Y/YN), fz=labF(Z/ZN);
    var aStar=500*(fx-fy), bStar=200*(fy-fz);
    sumA+=aStar; sumB+=bStar; sumA2+=aStar*aStar; sumB2+=bStar*bStar;
    var rg=r-g, yb=0.5*(r+g)-b;
    sumRG+=rg; sumYB+=yb; sumRG2+=rg*rg; sumYB2+=yb*yb;
  }
  var ent=0;
  if(hueCount>0){
    for(var hb=0; hb<36; hb++){
      if(hueHist[hb]>0){ var p=hueHist[hb]/hueCount; ent-=p*Math.log(p); }
    }
    ent/=Math.log(36);
  }
  var distinct=0, domMax=0;
  for(var dk=0; dk<4096; dk++){ distinct+=distinctArr[dk]; if(domCounts[dk]>domMax) domMax=domCounts[dk]; }
  var meanA=sumA/npix, meanBv=sumB/npix;
  var abSpread=Math.sqrt(Math.max(0, sumA2/npix-meanA*meanA) + Math.max(0, sumB2/npix-meanBv*meanBv));
  var meanRG=sumRG/npix, meanYB=sumYB/npix;
  var stdRG=Math.sqrt(Math.max(0, sumRG2/npix-meanRG*meanRG));
  var stdYB=Math.sqrt(Math.max(0, sumYB2/npix-meanYB*meanYB));
  var colorfulness=Math.sqrt(stdRG*stdRG + stdYB*stdYB) + 0.3*Math.sqrt(meanRG*meanRG + meanYB*meanYB);
  var localSum=0, localCount=0;
  for(var by=0; by<h; by+=8){
    for(var bx=0; bx<w; bx+=8){
      var bwA=Math.min(8, w-bx), bhA=Math.min(8, h-by), nB=bwA*bhA;
      if(nB<4) continue;
      for(var ch=0; ch<3; ch++){
        var s=0, s2=0;
        for(var yy=0; yy<bhA; yy++){
          var rowOff=((by+yy)*w + bx)*4 + ch;
          for(var xx=0; xx<bwA; xx++){ var vv=data[rowOff + xx*4]; s+=vv; s2+=vv*vv; }
        }
        var mm=s/nB;
        localSum+=Math.sqrt(Math.max(0, s2/nB - mm*mm)); localCount++;
      }
    }
  }
  return { hueEntropy:ent, distinct:distinct, dominantShare:(npix? domMax/npix : 0),
    abSpread:abSpread, colorfulness:colorfulness, meanSat:(npix? sumSat/npix : 0),
    localVar:(localCount? localSum/localCount : 0) };
}
function monoOrig(){
  if(monoOrigMetrics) return monoOrigMetrics;
  var base=monoBase96(); if(!base) return null;
  monoOrigMetrics=computeMonoMetrics(base.data, base.w, base.h);
  return monoOrigMetrics;
}
function monoMetricsFor(idx){
  if(monoMetricsCache[idx]) return monoMetricsCache[idx];
  var base=monoBase96(); if(!base) return null;
  if(!monoOrig()) return null;
  var power=geneSafePower[idx];
  if(typeof power!=="number" || !isFinite(power)) return null;
  var copy=new Uint8ClampedArray(base.data);
  var view={ data:copy, width:base.w, height:base.h };
  try{ processGenome(view, singleLutGenome(idx, power), null); }catch(e){ return null; }
  var m=computeMonoMetrics(copy, base.w, base.h);
  monoMetricsCache[idx]=m;
  return m;
}
function monoFailsFor(idx){
  var fails={};
  if(!monoMasterOn) return fails;
  var orig=monoOrig(), trans=monoMetricsFor(idx);
  if(!orig || !trans) return fails;
  if(monoOn("hueEntropy") && (orig.hueEntropy - trans.hueEntropy) > monoThr("hueEntropy") + 1e-12) fails.hueEntropy=true;
  if(monoOn("distinct") && orig.distinct>0 && ((orig.distinct - trans.distinct)/orig.distinct*100) > monoThr("distinct") + 1e-12) fails.distinct=true;
  if(monoOn("abSpread") && orig.abSpread>1e-9 && ((orig.abSpread - trans.abSpread)/orig.abSpread*100) > monoThr("abSpread") + 1e-12) fails.abSpread=true;
  if(monoOn("colorfulness") && orig.colorfulness>1e-9 && ((orig.colorfulness - trans.colorfulness)/orig.colorfulness*100) > monoThr("colorfulness") + 1e-12) fails.colorfulness=true;
  if(monoOn("meanSat") && (orig.meanSat - trans.meanSat) > monoThr("meanSat") + 1e-12) fails.meanSat=true;
  if(monoOn("dominant") && ((trans.dominantShare - orig.dominantShare)*100) > monoThr("dominant") + 1e-12) fails.dominant=true;
  if(monoOn("localVar") && orig.localVar>1e-9 && ((orig.localVar - trans.localVar)/orig.localVar*100) > monoThr("localVar") + 1e-12) fails.localVar=true;
  return fails;
}
/* Delta de monotonía de un gen en las unidades del slider de cada
   indicador (las mismas magnitudes que compara monoFailsFor): caída
   absoluta en entropía de tono y saturación media, pérdida en % en
   colores distintos, extensión a*b*, colorfulness y variedad local,
   y subida en puntos % en color dominante. */
function monoDelta(orig, trans, id){
  if(id==="hueEntropy") return orig.hueEntropy - trans.hueEntropy;
  if(id==="distinct") return orig.distinct>0 ? (orig.distinct - trans.distinct)/orig.distinct*100 : 0;
  if(id==="abSpread") return orig.abSpread>1e-9 ? (orig.abSpread - trans.abSpread)/orig.abSpread*100 : 0;
  if(id==="colorfulness") return orig.colorfulness>1e-9 ? (orig.colorfulness - trans.colorfulness)/orig.colorfulness*100 : 0;
  if(id==="meanSat") return orig.meanSat - trans.meanSat;
  if(id==="dominant") return (trans.dominantShare - orig.dominantShare)*100;
  if(id==="localVar") return orig.localVar>1e-9 ? (orig.localVar - trans.localVar)/orig.localVar*100 : 0;
  return 0;
}
/* Máximo adaptativo por imagen: tras calcular los deltas de todos los
   genes, el máximo de cada slider pasa a ser la peor caída observada
   entre los genes (la mayor subida en color dominante), redondeada
   hacia arriba al paso del slider; si ninguna LUT empeora un
   indicador, su máximo queda en 0. El valor del slider arranca en el
   mínimo entre su default y ese máximo. Solo se recalcula aquí, al
   subir una imagen nueva: mover sliders o «Volver a filtrar» no lo
   cambia. */
function applyAdaptiveMonoMaxes(){
  var orig=monoOrig(); if(!orig) return;
  var ordered=[];
  [customGeneGridEl, geneGridEl].forEach(function(grid){
    if(!grid) return;
    Array.prototype.forEach.call(grid.children, function(w){
      var idx=parseInt(w.dataset.lutIdx, 10);
      if(!isNaN(idx) && ordered.indexOf(idx)<0) ordered.push(idx);
    });
  });
  var worst={};
  MONO_INDICATORS.forEach(function(ind){ worst[ind.id]=0; });
  ordered.forEach(function(idx){
    var trans=monoMetricsFor(idx); if(!trans) return;
    MONO_INDICATORS.forEach(function(ind){
      var d=monoDelta(orig, trans, ind.id);
      if(isFinite(d) && d>worst[ind.id]) worst[ind.id]=d;
    });
  });
  MONO_INDICATORS.forEach(function(ind){
    var w=worst[ind.id]; if(!(w>0)) w=0;
    var adapt= w===0 ? 0 : Math.ceil(w/ind.step - 1e-9)*ind.step;
    adapt=Math.round(adapt/ind.step)*ind.step;
    if(ind.step<1) adapt=parseFloat(adapt.toFixed(2));
    ind.max=adapt;
    var val=Math.min(ind.def, adapt);
    if(ind.step<1) val=parseFloat(val.toFixed(2));
    monoThresholds[ind.id]=val;
    var slider=document.getElementById("monoThr-"+ind.id);
    var thrVal=document.getElementById("monoThrVal-"+ind.id);
    if(slider){ slider.max=String(adapt); slider.value=String(monoSliderPos(ind, val)); slider.setAttribute("aria-valuetext", ind.fmt(val)); }
    if(thrVal) thrVal.textContent=ind.fmt(val);
  });
}
function hideMonoGeneCard(idx){
  monoHiddenSet[idx]=true;
  detachGeneCard(idx);
}
/* Descarte de monótonos sobre las tarjetas presentes en el DOM, en el
   orden actual. Reinicia los conteos en cada pasada: un indicador
   desmarcado (o el maestro desmarcado) queda a 0 y no mata nada. */
function applyMonoFilter(){
  MONO_INDICATORS.forEach(function(ind){ monoKills[ind.id]=0; });
  monoHiddenSet={}; monoHiddenCount=0;
  if(!monoMasterOn){ updateMonoKillUI(); return []; }
  if(!monoOrig()){ updateMonoKillUI(); return []; }
  var ordered=[];
  [customGeneGridEl, geneGridEl].forEach(function(grid){
    if(!grid) return;
    Array.prototype.forEach.call(grid.children, function(w){
      var idx=parseInt(w.dataset.lutIdx, 10);
      if(!isNaN(idx) && ordered.indexOf(idx)<0) ordered.push(idx);
    });
  });
  var hidden=[];
  ordered.forEach(function(idx){
    var fails=monoFailsFor(idx);
    var ids=Object.keys(fails);
    if(ids.length){
      ids.forEach(function(id){ monoKills[id]++; });
      hidden.push(idx);
    }
  });
  hidden.forEach(hideMonoGeneCard);
  monoHiddenCount=hidden.length;
  updateMonoKillUI();
  renumberGeneCards();
  updateCustomSectionVisibility();
  return hidden;
}
/* Botón «Volver a filtrar»: pipeline completo desde el conjunto
   completo de genes, con los valores actuales de todos los controles
   y SIN volver a autoajustar la mediana de potencia mínima (el slider
   se usa tal como esté). Orden: monótonos → familiares → potencia. */
function refilterGenes(){
  if(!genePhase || rendering) return;
  if(!source) return;
  restoreAllGeneCards();
  sortGeneCards();
  applyMonoFilter();
  applySimilarityFilter();
  applyMinPowerFilter();
  var items=[];
  Object.keys(geneCellEls).forEach(function(k){
    var idx=parseInt(k, 10);
    if(geneMinPowerHidden[idx]) return;
    var ui=genePowerEls[idx];
    if(!ui || !ui.canvas) return;
    items.push({ genome:singleLutGenome(idx), canvas:ui.canvas });
  });
  syncGeneUI();
  if(items.length) renderGeneThumbs(items);
  else { statusEl.textContent="Elige tus LUTs."; }
}
/* Calcula la potencia de arranque de cada preview por tandas (la
   búsqueda binaria corre el diagnóstico por LUT) y, al terminar,
   renderiza las miniaturas ya con su genoma a esa potencia. */
function computeGeneStartIntensities(pending){
  if(!pending.length){ renderGeneThumbs([]); return; }
  var token=++geneComputeToken;
  /* El checkbox queda inactivo mientras se calculan las potencias:
     un cambio a mitad de tanda competiría con este render. */
  if(genePreviews100El) genePreviews100El.disabled=true;
  if(geneMinPowerEl) geneMinPowerEl.disabled=true;
  rendering=true; syncSelectionUI();
  progressEl.style.display="block"; progressBar.style.width="0%";
  statusEl.textContent="Calculando potencias seguras…";
  var i=0, items=[];
  function step(){
    if(token!==geneComputeToken) return; /* llegó otra imagen: esta tanda ya no vale */
    var t0=Date.now();
    while(i<pending.length && Date.now()-t0<90){
      var p=pending[i];
      try{ geneSafePower[p.idx]=geneStartIntensity(p.idx); }
      catch(e){ geneSafePower[p.idx]=0.5; }
      /* La preview arranca a la potencia máxima segura, salvo que
         «Previews al 100%» ya esté marcado: entonces, al 100%. */
      geneIntensity[p.idx]= (genePreviews100El && genePreviews100El.checked) ? 1 : geneSafePower[p.idx];
      setGenePowerUI(p.idx);
      items.push({ genome:singleLutGenome(p.idx), canvas:p.canvas });
      i++;
      progressBar.style.width=Math.round(i/pending.length*100)+"%";
      statusEl.textContent="Calculando potencias seguras "+i+"/"+pending.length+"…";
    }
    if(i<pending.length){ setTimeout(step, 0); return; }
    rendering=false; progressEl.style.display="none";
    /* Con todas las potencias ya calculadas, las tarjetas se ordenan
       por potencia de disparo descendente antes de mostrarse. */
    sortGeneCards();
    /* Pipeline: 1º monótonos, 2º familias, 3º potencia mínima.
       Ya ordenadas por potencia, primero el descarte de monótonos:
       una LUT potente pero monótona no debe convertirse en campeona
       de su familia. Sus miniaturas ni se generan. items va alineado
       con pending. */
    /* Con los deltas de todos los genes ya calculados, los máximos de
       los sliders de monotonía se adaptan a esta imagen antes de
       filtrar: ningún máximo queda por encima de la peor caída real. */
    applyAdaptiveMonoMaxes();
    var monoHiddenIdxs=applyMonoFilter();
    var hiddenIdxs=applySimilarityFilter();
    var allHidden=monoHiddenIdxs.concat(hiddenIdxs);
    var alivePending=pending;
    if(allHidden.length){
      var hs={}; allHidden.forEach(function(ix){ hs[ix]=true; });
      items=items.filter(function(it, ii){ return !hs[pending[ii].idx]; });
      alivePending=pending.filter(function(p){ return !hs[p.idx]; });
      syncGeneUI();
    }
    /* Ya con los supervivientes de monótonos y de familias, el slider
       de potencia mínima se autoajusta a la mitad de ellos antes de
       aplicar ese filtro (solo aquí, al empezar la fase). La mediana
       se calcula sobre esos supervivientes, no sobre el total. */
    autoAdjustGeneMinPower();
    /* Después del filtro de familias, el de potencia mínima sobre los
       supervivientes, ya con el umbral autoajustado. */
    applyMinPowerFilter();
    if(Object.keys(geneMinPowerHidden).length){
      items=items.filter(function(it, ii){ return !geneMinPowerHidden[alivePending[ii].idx]; });
    }
    if(genePreviews100El) genePreviews100El.disabled=false;
    if(geneMinPowerEl) geneMinPowerEl.disabled=false;
    renderGeneThumbs(items);
  }
  setTimeout(step, 30);
}
function confirmGeneSelection(){
  var idxs=Object.keys(geneSelected);
  if(!idxs.length){ showToast("Elige al menos 1 gen."); return; }
  allowedSet={};
  idxs.forEach(function(k){ allowedSet["lut"+k]=true; });
  /* Los pasos de grading no se eligen: siempre están permitidos. */
  FIXED_KEYS.forEach(function(k){ allowedSet[k]=true; });
  ["tonemapAmt","satAmt","hueselShift","curvesLift","curvesGamma","curvesGain","curvesShad","curvesHigh"].forEach(function(k){ allowedSet[k]=true; });
  genePhase=false;
  genePhaseEl.hidden=true;
  syncGeneUI(); /* esconde el botón flotante al iniciar la evolución */
  if(stageLayoutEl2) stageLayoutEl2.style.display="";
  /* Solo las LUTs elegidas pasan a 65³, y solo a partir de ahora:
     durante la fase de genes no se generó ninguna. */
  ensureLuts65(idxs.map(function(k){ return parseInt(k,10); }), null);
  buildGrid();
  newPopulationFromAncestor();
  showToast("Evolución iniciada.");
}
btnStartEv.addEventListener("click", confirmGeneSelection);
btnStartEv2.addEventListener("click", confirmGeneSelection);
if(btnStartEvFloat) btnStartEvFloat.addEventListener("click", confirmGeneSelection);
document.getElementById("btnGeneAll").addEventListener("click", function(){
  geneSelected={};
  geneCellEls.forEach(function(el, i){
    if(geneMinPowerHidden[i]) return; /* oculto por potencia mínima: «Todos» no lo elige */
    if(typeof monoHiddenSet!=="undefined" && monoHiddenSet[i]) return; /* oculto por monótono: «Todos» no lo elige */
    if(typeof geneHiddenSet!=="undefined" && geneHiddenSet[i]) return; /* oculto por familia: «Todos» no lo elige */
    geneSelected[i]=true; el.setAttribute("aria-pressed","true");
  });
  syncGeneUI();
});
document.getElementById("btnGeneNone").addEventListener("click", function(){
  geneSelected={};
  geneCellEls.forEach(function(el){ el.setAttribute("aria-pressed","false"); });
  syncGeneUI();
});

/* ---------- LUTs propias en la fase de genes ---------- */
function updateCustomSectionVisibility(){
  if(!customGeneGridEl) return;
  var has=false;
  Array.prototype.forEach.call(customGeneGridEl.children, function(w){
    var idx=parseInt(w.dataset.lutIdx, 10);
    if(!geneMinPowerHidden[idx]) has=true;
  });
  customGeneGridEl.hidden=!has;
  if(customLutsTitleEl) customLutsTitleEl.hidden=!has;
}
function makeCustomGeneCell(idx){
  var cu=CUSTOM_BY_IDX[idx];
  var wrap=document.createElement("div"); wrap.className="gene-custom-wrap";
  wrap.dataset.lutIdx=idx;
  var b=document.createElement("button");
  b.type="button"; b.className="gene-cell gene-cell-custom";
  b.setAttribute("aria-pressed", geneSelected[idx]?"true":"false");
  b.setAttribute("aria-label", cu.name+". Toca para elegirla como gen.");
  var cv=document.createElement("canvas"); cv.width=GW; cv.height=GH;
  b.appendChild(cv);
  var chk=document.createElement("span"); chk.className="check";
  chk.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  b.appendChild(chk);
  var nm=document.createElement("span"); nm.className="gname"; nm.textContent=cu.name; nm.title=cu.name;
  b.appendChild(nm);
  b.addEventListener("click", function(){ toggleGene(idx); });
  wrap.appendChild(b);
  var del=document.createElement("button");
  del.type="button"; del.className="gene-del";
  del.title="Quitar esta LUT"; del.setAttribute("aria-label", "Quitar "+cu.name);
  del.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  del.addEventListener("click", function(e){ e.stopPropagation(); removeCustomLut(idx); });
  wrap.appendChild(del);
  wrap.appendChild(makeGenePowerRow(idx, cv));
  return { wrap:wrap, btn:b, canvas:cv };
}
function removeCustomLut(idx){
  var cu=CUSTOM_BY_IDX[idx]; if(!cu || cu.removed) return;
  cu.removed=true;
  lut65Cache.delete(idx);
  if(typeof GPU!=="undefined" && GPU && GPU.invalidateLut) GPU.invalidateLut(idx);
  idbDelete(cu.idbId);
  if(geneSelected[idx]) delete geneSelected[idx];
  var el=geneCellEls[idx];
  if(el){
    var node=(el.parentNode && el.parentNode.className==="gene-custom-wrap") ? el.parentNode : el;
    if(node.parentNode) node.parentNode.removeChild(node);
  }
  if(typeof geneDetached!=="undefined" && geneDetached[idx]) delete geneDetached[idx];
  if(typeof monoHiddenSet!=="undefined") delete monoHiddenSet[idx];
  if(typeof geneHiddenSet!=="undefined") delete geneHiddenSet[idx];
  if(typeof monoMetricsCache!=="undefined") delete monoMetricsCache[idx];
  delete geneCellEls[idx];
  delete geneIntensity[idx];
  delete geneSafePower[idx];
  delete genePowerEls[idx];
  delete geneMinPowerHidden[idx];
  updateCustomSectionVisibility();
  syncGeneUI();
  showToast("LUT quitada.");
}
function addCustomGeneCard(idx){
  if(!genePhase || !customGeneGridEl) return;
  var c=makeCustomGeneCell(idx);
  customGeneGridEl.appendChild(c.wrap);
  geneCellEls[idx]=c.btn;
  updateCustomSectionVisibility();
  try{ geneSafePower[idx]=geneStartIntensity(idx); }catch(e){ geneSafePower[idx]=0.5; }
  geneIntensity[idx]= (genePreviews100El && genePreviews100El.checked) ? 1 : geneSafePower[idx];
  setGenePowerUI(idx);
  /* La recién añadida entra en su sitio según su potencia de disparo. */
  sortGeneGrid(customGeneGridEl, false);
  renderGeneThumbCpu(c.canvas, singleLutGenome(idx));
  syncGeneUI();
  /* Primero monótonos, como en el pipeline completo: si la propia es
     monótona para esta imagen, queda oculta, suma a los conteos de
     los indicadores que falla y no entra en el recorrido de familias
     (no puede matar a familiares con colores más ricos). */
  if(typeof monoFailsFor==="function"){
    var mfails=monoFailsFor(idx);
    var mfIds=Object.keys(mfails);
    if(mfIds.length){
      mfIds.forEach(function(id){ monoKills[id]++; });
      updateMonoKillUI();
      hideMonoGeneCard(idx);
      monoHiddenCount++;
      applyMinPowerFilter();
      syncGeneUI();
      return;
    }
  }
  /* La propia también tiene firma: entra en el mismo recorrido de
     campeón con las demás (puede quedar oculta u ocultar a otras). */
  applySimilarityFilter();
  /* Y pasa por el filtro de potencia mínima con su propia potencia de
     disparo, como las demás supervivientes del filtro de familias. */
  applyMinPowerFilter();
  syncGeneUI();
}
function handleLutFiles(fileList){
  var files=Array.prototype.slice.call(fileList||[]);
  if(!files.length) return;
  var queue=files.slice();
  function next(){
    var file=queue.shift();
    if(!file) return;
    if(!/\.cube$/i.test(file.name||"")){ showToast("«"+(file.name||"archivo")+"» no es .cube."); next(); return; }
    var dup=false;
    for(var i=0;i<LUTS.length;i++){ var cu=CUSTOM_BY_IDX[i]; if(cu && !cu.removed && cu.name===file.name){ dup=true; break; } }
    if(dup){ showToast("«"+file.name+"» ya está cargada."); next(); return; }
    var reader=new FileReader();
    reader.onload=function(){
      try{
        var parsed=parseCubeText(String(reader.result||""));
        var rec={ idbId:"lut-"+Date.now()+"-"+Math.floor(Math.random()*1e9), name:file.name, origSize:parsed.size, addedAt:Date.now(), data:parsed.data };
        var idx=registerCustomRecord(rec);
        customRecords.push(rec);
        idbPut(rec);
        addCustomGeneCard(idx);
        showToast("LUT «"+file.name+"» añadida.");
      }catch(err){ showToast("«"+file.name+"» no es un .cube válido."); }
      next();
    };
    reader.onerror=function(){ showToast("No se pudo leer «"+file.name+"»."); next(); };
    reader.readAsText(file);
  }
  next();
}
var lutDropEl=document.getElementById("lutDrop"), lutFileInputEl=document.getElementById("lutFileInput");
if(lutDropEl && lutFileInputEl){
  lutDropEl.addEventListener("click", function(){ lutFileInputEl.click(); });
  lutDropEl.addEventListener("keydown", function(e){ if(e.key==="Enter" || e.key===" "){ e.preventDefault(); lutFileInputEl.click(); } });
  var btnPickLutsEl=document.getElementById("btnPickLuts");
  if(btnPickLutsEl) btnPickLutsEl.addEventListener("click", function(e){ e.stopPropagation(); lutFileInputEl.click(); });
  lutFileInputEl.addEventListener("change", function(){ handleLutFiles(lutFileInputEl.files); lutFileInputEl.value=""; });
  ["dragenter","dragover"].forEach(function(ev){ lutDropEl.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); lutDropEl.classList.add("dragging"); }); });
  ["dragleave","drop"].forEach(function(ev){ lutDropEl.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); lutDropEl.classList.remove("dragging"); }); });
  lutDropEl.addEventListener("drop", function(e){ var f=e.dataTransfer && e.dataTransfer.files; if(f && f.length) handleLutFiles(f); });
}

/* ---------- Población inicial y evolución ---------- */
function newPopulationFromAncestor(){
  resetGenePins(); /* Gen 0 nuevo: ningún pin se hereda, salvo Hue, que nace fijado en 0, 0 */
  resetGenKills();
  var anc=ancestorGenome();
  /* Generación 0 con Límites seguros: si el checkbox está activo, cada
     variante inicial solo entra si no activa ningún aviso (la misma
     criba que la descendencia, vía makeSafeInitialGenome); el clon del
     ancestro también se repara si avisara. Sin el checkbox, la
     generación 0 nace suave como siempre. */
  var safeOn=safeBoundsOn();
  var first=cloneGenome(anc,"ancestro","Base");
  if(safeOn && warnKeyCount(analyzePipeline(first))>0) first=repairToSafe(first);
  applyGenePins(first); /* el clon del ancestro también nace con los pins aplicados: Hue en 0, 0 */
  population=[ first ];
  for(var i=1;i<POP_SIZE;i++) population.push(applyGenePins(safeOn ? makeSafeInitialGenome(anc, i) : softInitialGenome(anc, i)));
  population=shuffled(population);
  generation=0; selected={}; detailCell=-1; pinnedCell=CENTER_CELL; previewCell=CENTER_CELL;
  cellEls.forEach(function(el){ el.setAttribute("aria-pressed","false"); });
  genBadge.textContent="Gen 0";
  syncSelectionUI();
  renderPopulation();
}


/* ---------- Límites seguros (safe bounds) ----------
   Con el checkbox activado (por defecto), la generación 0 y la
   descendencia de los sobrevivientes solo se aceptan si analyzePipeline no detecta ningún
   aviso en ninguna transformación: el mismo diagnóstico que pinta los
   iconos ámbar de Transformaciones (clipping en luces/sombras,
   overflow, aplanamiento, fuera de gamut, grises con tinte, balance de
   blancos, tinte verde-magenta, saturación o contraste excesivos,
   pérdida de detalle, punto negro/blanco, cambio de tono, contraste
   local, luminancia media, GMSD y SSIM bajo). La búsqueda es por rechazo: se generan
   hijos por cruce + mutación y se descartan los que avisan; la criba
   rápida va a 96 px y cada candidato aceptado se verifica además con
   el diagnóstico completo a 144 px, el de los iconos. Si tras los
   intentos ninguno pasa, se repara el mejor candidato devolviendo a
   su valor por defecto cada paso que avisa y volviendo a comprobar,
   lo que en el peor caso converge al genoma identidad (sin avisos).
   La sangre nueva (inmigrantes) pasa por el mismo filtro, para que
   toda la generación nueva quede dentro de los límites; los
   sobrevivientes elegidos pasan intactos por elitismo, como siempre. */
function safeBoundsOn(){
  var chk=document.getElementById("chkSafeBounds");
  return !chk || !!chk.checked;
}
function warnKeyCount(map){ var n=0; for(var k in map){ if(Object.prototype.hasOwnProperty.call(map, k)) n++; } return n; }
/* Atenuar un gen a la mitad hacia su punto neutro, en vez de devolverlo
   a cero: la reparación conserva la mayor fuerza que aún pasa los
   Límites seguros, así la variante reparada sigue siendo una ruta
   visible y no una copia del original. Los genes principales
   categóricos (operador de tone mapping, modelo de saturación, hue
   objetivo) se conservan tal cual — lo que se atenúa es su intensidad
   (tonemapAmt hacia 0, que es su neutro y no def=1; satAmt hacia 1;
   hueselShift hacia 0) — así la ruta sobrevive aunque sea más suave. */
function softenGene(cur, gkey, spec){
  var v=cur.values[gkey]; if(v===undefined) return;
  if(gkey==="tonemap" || gkey==="sat" || gkey==="huesel") return;
  var neutral = gkey==="tonemapAmt" ? 0 : spec.def;
  cur.values[gkey]=neutral+(v-neutral)*0.5;
}
function repairToSafe(g){
  var cur=cloneGenome(g, g.kind, g.lineage);
  for(var it=0; it<10; it++){
    var keys=Object.keys(analyzePipeline(cur));
    if(!keys.length) return cur;
    keys.forEach(function(key){
      var f=FBY[key]; if(!f) return;
      softenGene(cur, f.key, f);
      subGenesOf(f).forEach(function(sg){ softenGene(cur, sg.gkey, sg); });
    });
  }
  if(!Object.keys(analyzePipeline(cur)).length) return cur;
  var id=identityGenome(); id.kind=g.kind; id.lineage=g.lineage;
  return id;
}
/* Evalúa un candidato para Límites seguros respetando indicadores
   activos y umbrales: primero criba rápida a 96 px y, si pasa, el
   diagnóstico completo a 144 px. Devuelve si pasa, el conjunto de
   indicadores que activó (para el kill count) y una puntuación para
   elegir el mejor candidato a reparar. */
function evaluateSafeCandidateInner(g){
  var fastD=analyzePipelineDetailed(g, 96);
  var fastCount=warnKeyCount(fastD.map);
  /* Degenerada: la imagen final es casi toda negra o casi toda blanca
     (media de luma fuera de [8,247] o >90% de canales en 0 o en 255).
     Medido en node sobre la imagen de prueba 2: la variante negra
     (curvas aplastantes) da media 0.1 y 95.6% a 0; una ruta azul sana
     106.9 y 0%, un moody moderado 75.9 y 5.4%, una clara 183.1 y 41.6%
     a 255 — el umbral 90% las deja pasar a todas y solo veta la
     destruida. NaN en la media también cuenta como degenerada. */
  var ff=fastD.final||{mean:NaN,pct0:0,pct255:0};
  var degen=isNaN(ff.mean)||ff.mean<8||ff.mean>247||ff.pct0>90||ff.pct255>90;
  if(fastCount===0){
    var fullD=analyzePipelineDetailed(g);
    if(warnKeyCount(fullD.map)===0) return {pass:true, ids:{}, score:0, degenerate:false};
    return {pass:false, ids:fullD.ids, score:1, degenerate:degen};
  }
  return {pass:false, ids:fastD.ids, score:fastCount, degenerate:degen};
}
function makeSafeChild(a, b, rate){
  var tries= POP_SIZE<=8 ? 24 : POP_SIZE<=24 ? 14 : 8;
  var best=null, bestScore=Infinity, bestIdx=-1, failed=[];
  for(var t=0; t<tries; t++){
    var child=crossover(a, b);
    mutate(child, rate);
    applyGenePins(child); /* pin global: el valor fijado manda tras cruce y mutación */
    child.lineage="Cruce";
    var ev=evaluateSafeCandidate(child);
    if(ev.pass){ recordKills(failed, -1); return child; }
    failed.push(ev.ids);
    if(ev.score<bestScore){ bestScore=ev.score; best=child; bestIdx=failed.length-1; }
  }
  /* El reparado que sí se muestra no cuenta como kill: se excluye su
     conjunto de indicadores del conteo. */
  recordKills(failed, best ? bestIdx : -1);
  var repaired=repairToSafe(best || crossover(a, b));
  applyGenePins(repaired); /* ni la reparación puede mover un gen fijado */
  repaired.lineage="Cruce";
  return repaired;
}
function makeSafeImmigrant(){
  var tries= POP_SIZE<=24 ? 14 : 8;
  var best=null, bestScore=Infinity, bestIdx=-1, failed=[];
  for(var t=0; t<tries; t++){
    var g=randomGenome();
    var ev=evaluateSafeCandidate(g);
    if(ev.pass){ recordKills(failed, -1); return g; }
    failed.push(ev.ids);
    if(ev.score<bestScore){ bestScore=ev.score; best=g; bestIdx=failed.length-1; }
  }
  recordKills(failed, best ? bestIdx : -1);
  return repairToSafe(best || randomGenome());
}
/* Variante inicial segura (generación 0): la misma criba por rechazo
   que los inmigrantes, pero generando variantes suaves desde el
   ancestro; si ninguna pasa, se repara la mejor.
   Tolerancia Gen 0: se acepta una variante con hasta 2 avisos — Gen 0
   es el punto de partida y debe mostrar rutas (exposición, balance de
   blancos, curvas, saturación) aunque alguna venga con aviso; los
   avisos quedan visibles en los pasos de la variante. Sin esta
   tolerancia, la criba estricta + la reparación dejaban solo retoques
   de LUT y tono: en la verificación en vivo del 2026-11-24, exp/WB/
   curvas/sat quedaban en default en todas las variantes muestreadas.
   Veto degenerado: una variante tolerada cuya imagen final es casi
   toda negra o blanca (media de luma fuera de [8,247] o >90% de
   canales en 0/255, medido a 96 px) NO se acepta — es un extremo sin
   contenido, no una ruta (una combinación de curvas aplastante dejó
   una celda negra en la 5ª verificación en vivo). Las generaciones
   siguientes (hijos e inmigrantes) siguen exigiendo pasar sin avisos. */
var GEN0_TOLERANCE=2;
function makeSafeInitialGenome(base, idx){
  var tries= POP_SIZE<=24 ? 14 : 8;
  var best=null, bestScore=Infinity, bestIdx=-1, failed=[];
  for(var t=0; t<tries; t++){
    var g=softInitialGenome(base, idx);
    var ev=evaluateSafeCandidate(g);
    if(ev.pass || (ev.score<=GEN0_TOLERANCE && !ev.degenerate)){ recordKills(failed, -1); return g; }
    failed.push(ev.ids);
    if(ev.score<bestScore){ bestScore=ev.score; best=g; bestIdx=failed.length-1; }
  }
  recordKills(failed, best ? bestIdx : -1);
  return repairToSafe(best || softInitialGenome(base, idx));
}

/* ==================================================================
   Mapa · Árbol · Brújula
   ------------------------------------------------------------------
   MAPA: estadísticas de riesgo por gen calculadas SOLO a partir de
   evaluaciones reales de Límites seguros (cada veredicto que sale de
   evaluateSafeCandidate alimenta el mapa). El mapa no juzga: antes de
   que nazca un hijo genera una bolsa de propuestas, descarta las
   repetidas y las de mayor riesgo (contador visible en el panel) y
   solo las de menor riesgo se convierten en candidatos. Así son menos
   los candidatos que los 18 indicadores tienen que matar. El juez
   final de cada candidato que entra en la rejilla siguen siendo los
   18 indicadores, sin excepción: con Límites seguros activo, ningún
   hijo (guiado o pulido) entra sin pasar por evaluateSafeCandidate.
   BRÚJULA: aprende en la sesión qué aspecto te gusta. En cada
   Evolucionar compara las recompensas de los elegidos contra los no
   elegidos con actualización por diferencia (gradiente Bradley-Terry
   de ranking por pares, la misma matemática del RLHF): cada peso se
   mueve en proporción a cuánto difirió su rasgo entre elegidos y no
   elegidos. Las diferencias se blanquean antes por la correlación
   observada en la población evaluada, para que los rasgos que se
   mueven juntos compartan el crédito y los pesos se separen de
   verdad; la tasa es 0.3 y los pesos decaen un 15% hacia 0 en cada
   generación, siguiendo el gusto reciente. Hay 19
   recompensas: las 12 primeras y 7 nuevas (dirección del tinte en
   a* y b*, armonía de tonos, balance sombras/luces, picos de
   saturación,
   vibrance y suavidad de las transiciones de color), ninguna
   redundante con otra. La dirección se aprende: más puede ser bueno
   en una imagen y malo en otra. Con clic derecho sobre una variante,
   «Castigar look» mueve los pesos en contra de sus rasgos al instante
   (paso 1.2 = 4× el de una elección, señal explícita y fuerte,
   también sobre las nuevas, y con la dirección blanqueada),
   la excluye como padre y un segundo clic derecho revierte el
   castigo. Solo con el check «Recordar gustos»
   los pesos se guardan entre sesiones (en la misma IndexedDB de las
   LUTs propias); si no, cada imagen nueva empieza de cero, porque
   cada imagen es un mundo.
   ÁRBOL (2ª fase): tras elegir ganadores, cada hijo nace como K
   propuestas de cruce + mutación ordenadas por el mapa; entre las que
   el juez aprueba gana la de mayor recompensa según la brújula, y un
   descenso por coordenadas pule sus genes activos (cada paso vuelve
   a pasar por el juez si Límites seguros está activo). La sangre
   nueva sigue siendo aleatoria, como siempre.
   ================================================================== */
var REWARD_FEATURES=[
  {id:"rms", label:"Contraste RMS", tip:"Mide cuánto varían los brillos: más valor, más contraste global."},
  {id:"michelson", label:"Contraste Michelson", tip:"Mide la diferencia entre la zona más clara y la más oscura."},
  {id:"lumaEnt", label:"Entropía de luminancia", tip:"Mide cuánta variedad de brillos hay."},
  {id:"cct", label:"Temperatura de color media", tip:"Mide si la imagen tira a cálida o a fría."},
  {id:"sharp", label:"Nitidez", tip:"Mide cuánto detalle fino y bordes definidos hay."},
  {id:"abSpread", label:"Dispersión cromática a*b*", tip:"Mide cuánto se reparten los colores."},
  {id:"hueEnt", label:"Entropía de tono", tip:"Mide cuánta variedad de matices hay."},
  {id:"palette", label:"Tamaño de paleta", tip:"Mide cuántos colores distintos hay."},
  {id:"meanSat", label:"Saturación media", tip:"Mide la intensidad media del color."},
  {id:"colorfulness", label:"Colorfulness", tip:"Mide lo vivo y variado que se percibe el color."},
  {id:"dominant", label:"Color dominante", tip:"Mide cuánto manda el color más presente."},
  {id:"localVar", label:"Variedad local", tip:"Mide cuánto cambia el color de una zona a otra."},
  {id:"tintA", label:"Tinte a* (verde–magenta)", tip:"Mide el tinte verdoso o magenta."},
  {id:"tintB", label:"Tinte b* (azul–amarillo)", tip:"Mide el tinte azulado o amarillento."},
  {id:"hueHarmony", label:"Armonía de tonos", tip:"Mide lo bien que combinan los tonos entre sí."},
  {id:"shadowBalance", label:"Balance sombras/luces", tip:"Mide el equilibrio entre zonas oscuras y claras."},
  {id:"satPeaks", label:"Picos de saturación", tip:"Mide si hay zonas con la saturación muy concentrada."},
  {id:"vibrance", label:"Vibrance", tip:"Mide la intensidad de los colores apagados sin saturar los ya vivos."},
  {id:"chromaSmooth", label:"Suavidad de color", tip:"Mide lo suaves que son las transiciones entre colores."}
];
var compass={ on:true, force:0.7, remember:false, w:{}, picks:0, chosen:0, stats:{}, punishments:0, enabled:{} };
/* Checkbox por recompensa: desmarcar un índice lo ignora por completo
   (fuera del puntaje, del aprendizaje, del blanqueo y de los drivers);
   su peso queda intacto y vuelve tal cual al reactivarlo. Sin entrada
   en compass.enabled = activo (el comportamiento de siempre). */
function compassEnabled(id){ return compass.enabled[id]!==false; }
function compassActiveIdx(){
  var idx=[];
  REWARD_FEATURES.forEach(function(rf, fi){ if(compassEnabled(rf.id)) idx.push(fi); });
  return idx;
}
var featCache={}, rewardOrigCct=null;
var mapRisk={}, mapEvals=0, mapDupes=0, mapRiskDiscards=0, treeSeen={}, mapUiLast=0;
/* Pesos de la brújula: la barra del panel llega a ±3, pero el rango
   real es ±5, para que un rasgo que de verdad destaca pueda pesar más
   que el resto sin pegarse todos al mismo tope. El aprendizaje es
   actualización por diferencia (gradiente Bradley-Terry sobre pares
   elegido/no elegido, ver compassLearn) con tres correcciones contra
   el aplanamiento que se veía en la práctica (casi todos los pesos
   pegados y parecidos ya en la 6ª generación): (1) DECORRELACIÓN —
   antes de aprender, las diferencias de rasgos se blanquean por su
   dispersión observada en la población evaluada (matriz de
   correlación de la generación, blanqueo ZCA con regularización),
   así los rasgos que se mueven juntos (saturación, colorfulness,
   contraste, nitidez, dispersión…) comparten el crédito en vez de
   llevárselo cada uno completo, y solo lo que de verdad discrimina
   entre elegidos y no elegidos mueve su peso; (2) RITMO — tasa 0.3
   por elección (antes 0.8) y decaimiento del 15% por generación
   hacia 0 (antes 5%), para que los pesos sigan el gusto reciente y
   no se apelotonen en el tope tan pronto. (3) TEMPERATURA — el puntaje
   BT se divide por √(rasgos activos) para que la suma de 19 rasgos no
   sature la sigmoide con pesos de ±0.1 (2026-11-24, ver compassLearn).
   El castigo con clic
   derecho mantiene su paso fuerte relativo: 1.2, 4× el de una
   elección, y su dirección también va blanqueada. El panel muestra
   cada barra RELATIVA a la media de los pesos de la sesión (y la
   línea de estado da esa media), con los 3 drivers de mayor peso
   absoluto destacados; el puntaje sigue usando los pesos absolutos. */
var COMPASS_W_MAX=5, COMPASS_BAR_MAX=1, COMPASS_LR=0.3, COMPASS_DECAY=0.85, COMPASS_PUNISH_LR=1.2;
/* Castigos por clic derecho: firma del genoma → {deltas:{id:cambio
   aplicado}, cell:índice}. Guardar el cambio aplicado permite que el
   segundo clic derecho (toggle) lo revierta con exactitud. */
var punishedRecords={};
function clampCompassW(v){ return Math.max(-COMPASS_W_MAX, Math.min(COMPASS_W_MAX, v)); }
function isPunishedGenome(g){ return !!(g && punishedRecords[genomeSignature(g)]); }

function genomeSignature(g){
  var parts=[];
  for(var i=0;i<GENES.length;i++){
    var gn=GENES[i], v=g.values[gn.gkey];
    parts.push(v===undefined ? gn.def : Math.round(v*10000)/10000);
  }
  return g.order.join(",")+"|"+parts.join(",");
}
function origCct(){
  if(rewardOrigCct!==null) return rewardOrigCct;
  var base=monoBase96(); if(!base) return null;
  var d=base.data, n=base.w*base.h, sr=0, sg=0, sb=0;
  for(var i=0;i<d.length;i+=4){ sr+=d[i]; sg+=d[i+1]; sb+=d[i+2]; }
  rewardOrigCct=cctFromMeanRGB(sr/n, sg/n, sb/n);
  return rewardOrigCct;
}
/* Vector de recompensas de un genoma, medido a 96 px sobre el
   resultado final (la misma base de la fase de monótonos). Reutiliza
   computeMonoMetrics para las de cromaticidad y añade contraste RMS /
   Michelson, entropía de luminancia, CCT media y nitidez. Memoizado
   por firma del genoma dentro de la imagen. */
function rewardFeaturesCompute(g){
  var base=monoBase96(); if(!base) return null;
  var copy=new Uint8ClampedArray(base.data);
  var view={ data:copy, width:base.w, height:base.h };
  try{ processGenome(view, g, null); }catch(e){ return null; }
  var mm=computeMonoMetrics(copy, base.w, base.h);
  var w=base.w, h=base.h, npix=w*h;
  var hist=new Uint32Array(256), luma=new Float32Array(npix);
  var sum=0, sum2=0, sumR=0, sumG=0, sumB=0;
  for(var i=0, j=0;i<copy.length;i+=4, j++){
    var L=0.299*copy[i]+0.587*copy[i+1]+0.114*copy[i+2];
    luma[j]=L; sum+=L; sum2+=L*L;
    hist[Math.max(0, Math.min(255, Math.round(L)))]++;
    sumR+=copy[i]; sumG+=copy[i+1]; sumB+=copy[i+2];
  }
  var mean=sum/npix, sd=Math.sqrt(Math.max(0, sum2/npix-mean*mean));
  function pctL(p){ var t=p*npix, acc=0; for(var k=0;k<256;k++){ acc+=hist[k]; if(acc>=t) return k; } return 255; }
  var p1=pctL(0.01), p99=pctL(0.99);
  var bins=new Float64Array(32), ent=0;
  for(var b=0;b<256;b++) bins[b>>3]+=hist[b];
  for(var b2=0;b2<32;b2++){ if(bins[b2]>0){ var pp=bins[b2]/npix; ent-=pp*Math.log(pp); } }
  ent/=Math.log(32);
  var gs=0, gn=0;
  for(var y=0;y<h;y++){
    for(var x=0;x<w;x++){
      var idx=y*w+x;
      if(x<w-1){ gs+=Math.abs(luma[idx+1]-luma[idx]); gn++; }
      if(y<h-1){ gs+=Math.abs(luma[idx+w]-luma[idx]); gn++; }
    }
  }
  var cct=cctFromMeanRGB(sumR/npix, sumG/npix, sumB/npix);
  if(cct===null){ var oc=origCct(); cct= (oc!==null ? oc : 6500); }
  /* Seis rasgos nuevos, sobre la misma base de 96px y sin solaparse
     con los doce anteriores: dirección del tinte (a* y b* medios: el
     vector de tinte, no la calidez global que ya mide la CCT),
     armonía de tonos (relaciones ENTRE tonos, no cantidades), balance
     sombras/luces (dónde está la masa de píxeles, no su dispersión),
     picos de saturación (los acentos: el 5% más saturado, no la
     media), vibrance (cuánto se realzan los colores apagados) y
     suavidad de las transiciones de color (gradiente en a*b*, no el
     de luminancia que ya mide la nitidez). */
  var aArr=new Float32Array(npix), bArr=new Float32Array(npix);
  var satArr=new Float32Array(npix);
  var sumAf=0, sumBf=0, vibNum=0, vibDen=0;
  var hueHistF=new Float64Array(36), hueCntF=0;
  var hsvF=[0,0,0];
  for(var q2=0, p2=0; q2<copy.length; q2+=4, p2++){
    var rr=copy[q2], gg=copy[q2+1], bb=copy[q2+2];
    rgbToHsv01(rr/255, gg/255, bb/255, hsvF);
    satArr[p2]=hsvF[1];
    vibNum+=hsvF[1]*(1-hsvF[1]); vibDen+=(1-hsvF[1]);
    if(hsvF[1]>=0.1){
      var hb2=Math.floor(hsvF[0]/10); if(hb2<0) hb2=0; if(hb2>35) hb2=35;
      hueHistF[hb2]++; hueCntF++;
    }
    var Rl2=srgbLin(rr), Gl2=srgbLin(gg), Bl2=srgbLin(bb);
    var X2=(0.4124564*Rl2 + 0.3575761*Gl2 + 0.1804375*Bl2)*100;
    var Y2=(0.2126729*Rl2 + 0.7151522*Gl2 + 0.0721750*Bl2)*100;
    var Z2=(0.0193339*Rl2 + 0.1191920*Gl2 + 0.9503041*Bl2)*100;
    var fx2=labF(X2/XN), fy2=labF(Y2/YN), fz2=labF(Z2/ZN);
    var av=500*(fx2-fy2), bv=200*(fy2-fz2);
    aArr[p2]=av; bArr[p2]=bv; sumAf+=av; sumBf+=bv;
  }
  /* Picos de saturación: media del 5% de píxeles más saturados. */
  var satSorted=Float32Array.from(satArr).sort();
  var topN=Math.max(1, Math.round(npix*0.05)), topSum=0;
  for(var t2=npix-topN; t2<npix; t2++) topSum+=satSorted[t2];
  var satPeaks=topSum/topN;
  /* Armonía de tonos: cercanía de la distribución de tonos a un
     esquema armónico (mismo tono y análogos ±30°, triádicos 120°/240°,
     complementario 180°), como media ponderada sobre pares de bins
     del histograma de tono, en [0,1]. */
  var harmony=0;
  if(hueCntF>0){
    var anchors=[0,30,120,180,240,330], hsum=0, hw=0;
    for(var i1=0;i1<36;i1++){
      if(!hueHistF[i1]) continue;
      var pA=hueHistF[i1]/hueCntF;
      for(var i2=0;i2<36;i2++){
        if(!hueHistF[i2]) continue;
        var pB=hueHistF[i2]/hueCntF;
        var dd=Math.abs(i1-i2)*10; if(dd>180) dd=360-dd;
        var bestK=0;
        for(var ai=0;ai<anchors.length;ai++){
          var da=Math.abs(dd-anchors[ai]); if(da>180) da=360-da;
          var kk=Math.exp(-(da*da)/(2*15*15));
          if(kk>bestK) bestK=kk;
        }
        hsum+=pA*pB*bestK; hw+=pA*pB;
      }
    }
    harmony= hw>0 ? hsum/hw : 0;
  }
  /* Balance sombras/luces: fracción de píxeles en luces (luma ≥192)
     menos fracción en sombras (luma <64), en [-1,1]. */
  var shN=0, liN=0;
  for(var b3=0;b3<64;b3++) shN+=hist[b3];
  for(var b4=192;b4<256;b4++) liN+=hist[b4];
  var shadowBalance=(liN-shN)/npix;
  /* Suavidad de color: magnitud media del gradiente en a*b* mapeada a
     [0,1] con 1/(1+g), para que «más» sea «transiciones más suaves». */
  var cg=0, cgn=0;
  for(var yy2=0; yy2<h; yy2++){
    for(var xx2=0; xx2<w; xx2++){
      var ii2=yy2*w+xx2;
      if(xx2<w-1){ var dxa=aArr[ii2+1]-aArr[ii2], dxb=bArr[ii2+1]-bArr[ii2]; cg+=Math.sqrt(dxa*dxa+dxb*dxb); cgn++; }
      if(yy2<h-1){ var dya=aArr[ii2+w]-aArr[ii2], dyb=bArr[ii2+w]-bArr[ii2]; cg+=Math.sqrt(dya*dya+dyb*dyb); cgn++; }
    }
  }
  var chromaSmooth= 1/(1+(cgn ? cg/cgn : 0));
  return {
    rms: sd/255,
    michelson: (p99+p1)>0 ? (p99-p1)/(p99+p1) : 0,
    lumaEnt: ent,
    cct: cct,
    sharp: gn ? (gs/gn)/255 : 0,
    abSpread: mm.abSpread,
    hueEnt: mm.hueEntropy,
    palette: mm.distinct,
    meanSat: mm.meanSat,
    colorfulness: mm.colorfulness,
    dominant: mm.dominantShare,
    localVar: mm.localVar,
    tintA: sumAf/npix,
    tintB: sumBf/npix,
    hueHarmony: harmony,
    shadowBalance: shadowBalance,
    satPeaks: satPeaks,
    vibrance: vibDen>1e-9 ? vibNum/vibDen : 0,
    chromaSmooth: chromaSmooth
  };
}
function rewardFeaturesFor(g){
  if(!g) return null;
  var sig=genomeSignature(g);
  if(featCache[sig]) return featCache[sig];
  var f=rewardFeaturesCompute(g);
  if(f){ featCache[sig]=f; compassObserve(f); }
  return f;
}
function compassObserve(f){
  REWARD_FEATURES.forEach(function(rf){
    var st=compass.stats[rf.id];
    if(!st){ st=compass.stats[rf.id]={n:0, mean:0, m2:0}; }
    var x=f[rf.id]; st.n++;
    var d=x-st.mean; st.mean+=d/st.n; st.m2+=d*(x-st.mean);
  });
}
function compassZ(f, id){
  var st=compass.stats[id];
  if(!st || st.n<3) return 0;
  var sd=Math.sqrt(st.m2/st.n);
  return sd>1e-9 ? (f[id]-st.mean)/sd : 0;
}
function compassHasSignal(){
  if(!compass.on) return false;
  for(var k in compass.w){ if(compassEnabled(k) && Math.abs(compass.w[k])>0.02) return true; }
  return false;
}
function compassScore(f){
  if(!f || !compass.on) return 0;
  var s=0, tw=0;
  REWARD_FEATURES.forEach(function(rf){
    if(!compassEnabled(rf.id)) return;
    var w=compass.w[rf.id]||0; if(!w) return;
    s+=w*compassZ(f, rf.id); tw+=Math.abs(w);
  });
  return tw>0 ? (s/tw)*compass.force : 0;
}
function compassScoreFor(g){ return compassScore(rewardFeaturesFor(g)); }
/* ---------- Decorrelación: blanqueo ZCA de las diferencias ----------
   Los rasgos de la brújula se mueven juntos (saturación, colorfulness,
   contraste, nitidez y dispersión suben y bajan a la vez), así que con
   el gradiente directo cada uno se llevaba el crédito completo de la
   misma elección y todos los pesos se apelotonaban iguales. El
   blanqueo quita esa correlación ANTES de aprender: a partir de las
   filas z de la población evaluada se estima su matriz de correlación
   R (con contracción hacia la identidad, 0.25, para estabilizarla con
   pocas muestras) y se calculan W = R^(−1/2) y su inversa (ZCA, vía
   descomposición espectral por rotaciones de Jacobi). Las diferencias
   elegido/no elegido se expresan en el espacio blanqueado (dz' = W·dz)
   y los pesos también (w' = W^(−1)·w): el puntaje no cambia
   (w'·dz' = w·dz), pero el gradiente sí — la componente común de los
   rasgos correlados es una sola dirección blanqueada, así que el
   crédito se reparte entre ellos en vez de duplicarse, y solo lo que
   de verdad discrimina mueve su peso. Sin población suficiente se
   devuelve null y se aprende sin blanquear, como antes. */
function matVecMul(M, v){
  var o=new Array(v.length);
  for(var i=0;i<v.length;i++){
    var s=0, Mi=M[i];
    for(var j=0;j<v.length;j++) s+=Mi[j]*v[j];
    o[i]=s;
  }
  return o;
}
function jacobiEigen(Ain){
  var n=Ain.length, i, j, p, q, k;
  var A=[];
  for(i=0;i<n;i++){ A.push(Ain[i].slice()); }
  var V=[];
  for(i=0;i<n;i++){ var row=[]; for(j=0;j<n;j++) row.push(i===j ? 1 : 0); V.push(row); }
  for(var sweep=0; sweep<100; sweep++){
    var off=0;
    for(p=0;p<n;p++) for(q=p+1;q<n;q++) off+=A[p][q]*A[p][q];
    if(off<1e-12) break;
    for(p=0;p<n;p++){
      for(q=p+1;q<n;q++){
        var apq=A[p][q];
        if(Math.abs(apq)<1e-14) continue;
        var app=A[p][p], aqq=A[q][q];
        var theta=(aqq-app)/(2*apq);
        var t=(theta>=0 ? 1 : -1)/(Math.abs(theta)+Math.sqrt(theta*theta+1));
        var c=1/Math.sqrt(t*t+1), s=t*c, tau=s/(1+c);
        A[p][p]=app-t*apq; A[q][q]=aqq+t*apq; A[p][q]=0; A[q][p]=0;
        for(k=0;k<n;k++){
          if(k===p || k===q) continue;
          var akp=A[k][p], akq=A[k][q];
          A[k][p]=akp-s*(akq+tau*akp); A[p][k]=A[k][p];
          A[k][q]=akq+s*(akp-tau*akq); A[q][k]=A[k][q];
        }
        for(k=0;k<n;k++){
          var vkp=V[k][p], vkq=V[k][q];
          V[k][p]=vkp-s*(vkq+tau*vkp);
          V[k][q]=vkq+s*(vkp-tau*vkq);
        }
      }
    }
  }
  var vals=[];
  for(i=0;i<n;i++) vals.push(A[i][i]);
  return { vals:vals, vecs:V }; /* columnas de vecs = autovectores */
}
function compassWhiten(zRows){
  /* La dimensión sale de las filas: con índices ignorados, el blanqueo
     trabaja solo sobre el subespacio de los activos. */
  var d=(zRows.length && zRows[0]) ? zRows[0].length : REWARD_FEATURES.length, n=zRows.length;
  if(n<d+2) return null;
  var i, j, k;
  /* Correlación de las filas z (ya estandarizadas: su covarianza es
     la correlación), con contracción hacia la identidad. */
  var R=[];
  for(i=0;i<d;i++){ var rowR=new Array(d); for(j=0;j<d;j++) rowR[j]=0; R.push(rowR); }
  for(var r=0;r<n;r++){
    var zr=zRows[r];
    for(i=0;i<d;i++){
      if(!zr[i]) continue;
      for(j=i;j<d;j++){ R[i][j]+=zr[i]*zr[j]; }
    }
  }
  for(i=0;i<d;i++) for(j=i;j<d;j++){ R[i][j]/=n; if(i!==j) R[j][i]=R[i][j]; }
  for(i=0;i<d;i++) for(j=0;j<d;j++) R[i][j]= (i===j) ? (0.75*R[i][j]+0.25) : 0.75*R[i][j];
  var eig;
  try{ eig=jacobiEigen(R); }catch(e){ return null; }
  var W=[], Wi=[];
  for(i=0;i<d;i++){ W.push(new Array(d).fill(0)); Wi.push(new Array(d).fill(0)); }
  for(k=0;k<d;k++){
    var lam=Math.max(eig.vals[k], 0.08); /* suelo: acota la amplificación */
    var sq=Math.sqrt(lam);
    for(i=0;i<d;i++){
      var qi=eig.vecs[i][k];
      if(!qi) continue;
      for(j=0;j<d;j++){
        var qij=qi*eig.vecs[j][k];
        W[i][j]+=qij/sq;
        Wi[i][j]+=qij*sq;
      }
    }
  }
  return { W:W, Wi:Wi };
}
/* Aprendizaje por generación: elegidos contra no elegidos de la
   rejilla actual, con actualización por diferencia. Cada rasgo se
   normaliza (z) dentro de esta población y los pesos se mueven con el
   gradiente del modelo Bradley-Terry sobre todos los pares
   elegido/no elegido —la misma matemática del RLHF—: el empuje de
   cada peso es proporcional a cuánto difirió ese rasgo entre el
   elegido y el no elegido del par, atenuado por (1 − P), lo bien que
   la brújula ya predice ese par. Antes de acumular el gradiente, las
   diferencias y los pesos pasan por el blanqueo (compassWhiten): los
   rasgos correlados comparten el crédito y solo se acredita lo que
   de verdad discriminó la elección. Ritmo: tasa 0.3 por elección y
   decaimiento del 15% por generación hacia 0, para que pese el gusto
   reciente de la sesión y no la historia acumulada. Temperatura: el
   puntaje de cada par se divide por √(nº de rasgos activos) antes de
   la sigmoide — sin ella, la suma de 19 rasgos saturaba (1−P)→0 con
   pesos de apenas ±0.1 y las elecciones dejaban de mover la brújula
   (medido en node 2026-11-24: tras 4 generaciones con gusto fijo los
   pesos quedaban en ±0.1; con temperatura llegan a ~0.4). El paso del
   gradiente no se divide: solo se retrasa la saturación, la dirección
   aprendida es la misma. El tope no se mueve: ±5. */
function compassLearn(){
  if(!compass.on || (typeof genePhase!=="undefined" && genePhase)) return;
  var total=GRID_SIZE*GRID_SIZE, chosenF=[], restF=[];
  for(var ci=0; ci<total; ci++){
    var g=genomeAtCell(ci); if(!g) continue;
    if(isPunishedGenome(g)) continue; /* ya castigó al instante: no contar dos veces */
    var f=rewardFeaturesFor(g); if(!f) continue;
    if(selected[ci]) chosenF.push(f); else restF.push(f);
  }
  if(!chosenF.length || !restF.length) return;
  var all=chosenF.concat(restF);
  /* Media y desviación de cada rasgo dentro de esta generación. */
  var means={}, sds={};
  REWARD_FEATURES.forEach(function(rf){
    var m=0, i;
    for(i=0;i<all.length;i++) m+=all[i][rf.id];
    m/=all.length;
    var v=0;
    for(i=0;i<all.length;i++){ var d=all[i][rf.id]-m; v+=d*d; }
    means[rf.id]=m; sds[rf.id]=Math.sqrt(v/all.length);
  });
  /* Solo los índices activos aprenden: las filas z, el blanqueo y el
     gradiente viven en su subespacio; el peso de un índice ignorado
     ni se mueve ni decae. */
  var actIdx=compassActiveIdx();
  if(!actIdx.length) return;
  var BT_TEMP=Math.sqrt(actIdx.length); /* temperatura del puntaje BT: evita que la suma de 19 rasgos sature la sigmoide con pesos de ±0.1; el gradiente no se divide */
  function zRow(f){
    return actIdx.map(function(fi){
      var rf=REWARD_FEATURES[fi], sd=sds[rf.id];
      return sd>1e-9 ? (f[rf.id]-means[rf.id])/sd : 0;
    });
  }
  var zC=chosenF.map(zRow), zR=restF.map(zRow);
  /* Blanqueo: diferencias y pesos al espacio decorrelado. El puntaje
     de cada par es idéntico en ambos espacios (w'·dz' = w·dz); lo que
     cambia es la dirección del gradiente. */
  var wh=compassWhiten(zC.concat(zR));
  var wArr=actIdx.map(function(fi){ return compass.w[REWARD_FEATURES[fi].id]||0; });
  var zwC=zC, zwR=zR, wW=wArr;
  if(wh){
    zwC=zC.map(function(z){ return matVecMul(wh.W, z); });
    zwR=zR.map(function(z){ return matVecMul(wh.W, z); });
    wW=matVecMul(wh.Wi, wArr);
  }
  function scoreW(zw){
    var s=0;
    for(var fi=0; fi<zw.length; fi++) s+=wW[fi]*zw[fi];
    return s/BT_TEMP; /* puntaje temperado: misma dirección, saturación más tardía */
  }
  var scC=zwC.map(scoreW), scR=zwR.map(scoreW);
  var grad=actIdx.map(function(){ return 0; });
  for(var a=0; a<zwC.length; a++){
    for(var b=0; b<zwR.length; b++){
      var diff=scC[a]-scR[b];
      if(diff>30) continue; /* par ya predicho con certeza: no aporta */
      var omP=1/(1+Math.exp(diff)); /* 1 − σ(diff), acotado por el if */
      for(var fi2=0; fi2<grad.length; fi2++){
        var dz=zwC[a][fi2]-zwR[b][fi2];
        if(dz) grad[fi2]+=omP*dz;
      }
    }
  }
  var npairs=chosenF.length*restF.length;
  var dW=grad.map(function(gv){ return COMPASS_LR*gv/npairs; });
  if(wh) dW=matVecMul(wh.W, dW); /* el paso, de vuelta al espacio de pesos */
  actIdx.forEach(function(fi, k){
    var rf=REWARD_FEATURES[fi];
    var wOld=(compass.w[rf.id]||0)*COMPASS_DECAY;
    compass.w[rf.id]=clampCompassW(wOld + dW[k]);
  });
  compass.picks++; compass.chosen+=chosenF.length;
  if(compass.remember) compassSave();
  updateCompassUI();
}
/* ---------- Castigo con clic derecho ----------
   Castigar un look es una señal explícita y fuerte: sus rasgos se
   comparan con la media de la rejilla actual y los pesos de la
   brújula se mueven EN CONTRA de ese look al instante (paso 1.2 = 4×
   el de una elección, y con la dirección blanqueada por la
   correlación de la rejilla, igual que en el aprendizaje, para que
   los rasgos correlados del look compartan el castigo), sin esperar
   al próximo Evolucionar. La variante queda marcada, deseleccionada
   y excluida como padre. Un segundo clic derecho revierte
   exactamente el cambio aplicado y quita la marca. */
function compassPunishToggle(cellIdx){
  var g=genomeAtCell(cellIdx);
  if(!g || cellIdx===CENTER_CELL) return;
  var sig=genomeSignature(g);
  var rec=punishedRecords[sig];
  if(rec){
    /* Toggle: revertir el castigo con exactitud. */
    for(var id in rec.deltas){ compass.w[id]=clampCompassW((compass.w[id]||0)-rec.deltas[id]); }
    delete punishedRecords[sig];
    compass.punishments=Math.max(0, compass.punishments-1);
    if(compass.remember) compassSave();
    refreshPunishedUI(); updateCompassUI();
    showToast("Castigo quitado.");
    return;
  }
  var f=rewardFeaturesFor(g);
  if(!f){ showToast("Sin rasgos que castigar todavía."); return; }
  /* Media y desviación de la rejilla actual (sin el original). */
  var total=GRID_SIZE*GRID_SIZE, allF=[];
  for(var ci=0; ci<total; ci++){
    if(ci===CENTER_CELL) continue;
    var gg=genomeAtCell(ci); if(!gg) continue;
    var ff=rewardFeaturesFor(gg); if(ff) allF.push(ff);
  }
  if(allF.length<2){ showToast("Sin rejilla que comparar."); return; }
  /* Vector z del look frente a la rejilla, blanqueado por la
     correlación observada en esa misma rejilla. */
  var meansP={}, sdsP={};
  REWARD_FEATURES.forEach(function(rf){
    var m=0, i;
    for(i=0;i<allF.length;i++) m+=allF[i][rf.id];
    m/=allF.length;
    var v=0;
    for(i=0;i<allF.length;i++){ var d=allF[i][rf.id]-m; v+=d*d; }
    meansP[rf.id]=m; sdsP[rf.id]=Math.sqrt(v/allF.length);
  });
  /* El castigo también respeta los índices ignorados: solo mueve los
     activos, en su subespacio blanqueado. */
  var actIdxP=compassActiveIdx();
  function zRowP(ff){
    return actIdxP.map(function(fi){
      var rf=REWARD_FEATURES[fi], sd=sdsP[rf.id];
      return sd>1e-9 ? (ff[rf.id]-meansP[rf.id])/sd : 0;
    });
  }
  var zPun=zRowP(f);
  var whP=compassWhiten(allF.map(zRowP));
  if(whP) zPun=matVecMul(whP.W, zPun);
  var deltas={};
  actIdxP.forEach(function(fi, k){
    var rf=REWARD_FEATURES[fi];
    var z=zPun[k];
    if(Math.abs(z)<0.03) return;
    var old=compass.w[rf.id]||0;
    var nw=clampCompassW(old - COMPASS_PUNISH_LR*z);
    if(nw!==old) deltas[rf.id]=nw-old;
    compass.w[rf.id]=nw;
  });
  punishedRecords[sig]={ deltas:deltas, cell:cellIdx };
  compass.punishments++;
  /* Castigada no puede ser padre: fuera de la selección. */
  if(selected[cellIdx]){ delete selected[cellIdx]; if(cellEls[cellIdx]) cellEls[cellIdx].setAttribute("aria-pressed","false"); syncSelectionUI(); }
  if(compass.remember) compassSave();
  refreshPunishedUI(); updateCompassUI();
  showToast("Look castigado: la brújula aprende en contra y no será padre.");
}
function refreshPunishedUI(){
  if(typeof cellEls==="undefined" || !cellEls) return;
  for(var ci=0; ci<cellEls.length; ci++){
    var el=cellEls[ci]; if(!el) continue;
    var g=(ci===CENTER_CELL) ? null : genomeAtCell(ci);
    el.classList.toggle("is-punished", !!(g && punishedRecords[genomeSignature(g)]));
  }
}
/* Tras evolucionar, las marcas pertenecen a la rejilla anterior: se
   limpian (el castigo ya quedó en los pesos y la exclusión de padres
   ya se aplicó en esa evolución). */
function clearPunishedMarks(){ punishedRecords={}; refreshPunishedUI(); }
/* Menú contextual del grid: un solo menú reutilizado, anclado al clic. */
var punishMenuCell=-1;
function hidePunishMenu(){
  var m=document.getElementById("punishMenu");
  if(m) m.classList.remove("show");
  punishMenuCell=-1;
}
function showPunishMenu(cellIdx, x, y){
  var m=document.getElementById("punishMenu"); if(!m) return;
  var g=genomeAtCell(cellIdx); if(!g) return;
  punishMenuCell=cellIdx;
  var on=!!punishedRecords[genomeSignature(g)];
  var lab=document.getElementById("punishMenuLabel");
  if(lab) lab.textContent= on ? "Quitar castigo" : "Castigar look";
  var hint=document.getElementById("punishMenuHint");
  if(hint) hint.textContent= on ? "Revierte el castigo en la brújula." : "Castigo fuerte e inmediato en la brújula. No será padre.";
  m.classList.add("show");
  var mw=m.offsetWidth||210, mh=m.offsetHeight||92;
  m.style.left=Math.max(6, Math.min(x, window.innerWidth-mw-6))+"px";
  m.style.top=Math.max(6, Math.min(y, window.innerHeight-mh-6))+"px";
}
(function initPunishMenu(){
  var btn=document.getElementById("btnPunishToggle");
  if(btn) btn.addEventListener("click", function(){
    var ci=punishMenuCell;
    hidePunishMenu();
    if(ci>=0) compassPunishToggle(ci);
  });
  document.addEventListener("click", function(e){
    var m=document.getElementById("punishMenu");
    if(m && m.classList.contains("show") && !m.contains(e.target)) hidePunishMenu();
  });
  document.addEventListener("keydown", function(e){ if(e.key==="Escape") hidePunishMenu(); });
  window.addEventListener("resize", hidePunishMenu);
  window.addEventListener("scroll", hidePunishMenu, true);
})();

/* ---------- Mapa: riesgo por gen desde evaluaciones reales ---------- */
function evaluateSafeCandidate(g){
  var ev=evaluateSafeCandidateInner(g);
  mapObserve(g, ev);
  return ev;
}
function mapObserve(g, ev){
  mapEvals++;
  for(var i=0;i<GENES.length;i++){
    var gn=GENES[i], v=g.values[gn.gkey];
    if(v===undefined || v===gn.def) continue;
    var r=mapRisk[gn.gkey];
    if(!r){ r=mapRisk[gn.gkey]={n:0, bad:0}; }
    r.n++; if(!ev.pass) r.bad++;
  }
  var now=Date.now();
  if(now-mapUiLast>400){ mapUiLast=now; updateMapLine(); }
}
/* Riesgo medio de una propuesta según el mapa: genes sin historial
   parten de un prior neutro (0.3); los demás, de su tasa real de
   evaluaciones que activaron algún aviso, con suavizado +1/+2. */
function mapRiskScore(g){
  var s=0, n=0;
  for(var i=0;i<GENES.length;i++){
    var gn=GENES[i], v=g.values[gn.gkey];
    if(v===undefined || v===gn.def) continue;
    var r=mapRisk[gn.gkey];
    s+= r ? (r.bad+1)/(r.n+2) : 0.3;
    n++;
  }
  return n ? s/n : 0.3;
}
/* ---------- Árbol: hijo guiado + descenso por coordenadas ---------- */
function treeOn(){
  var c=document.getElementById("chkTree");
  return !c || !!c.checked;
}
function makeGuidedChild(a, b, rate, safeOn){
  var K= POP_SIZE<=24 ? 3 : 2;
  /* Pre-filtro del mapa, ANTES de nacer: se genera una bolsa de
     propuestas (3×K), se ordena por riesgo según el mapa y solo las K
     de menor riesgo llegan a ser candidatos. Las demás se descartan
     aquí, sin gastar ni una evaluación de los 18 indicadores: son
     hijos que el juez ya no tiene que matar. Las repetidas también se
     descartan en esta etapa. Contador visible en el panel. */
  var POOL=K*3, props=[], guard=0;
  while(props.length<POOL && guard++<POOL*3){
    var ch=crossover(a, b); mutate(ch, rate); applyGenePins(ch); ch.lineage="Cruce";
    var sig=genomeSignature(ch);
    if(treeSeen[sig]){ mapDupes++; updateMapLine(); continue; } /* propuesta repetida: el mapa la descarta sin gastar una evaluación */
    treeSeen[sig]=true; props.push(ch);
  }
  if(!props.length){
    var only=crossover(a, b); mutate(only, rate); applyGenePins(only); only.lineage="Cruce"; props.push(only);
  }
  props.sort(function(x, y){ return mapRiskScore(x)-mapRiskScore(y); });
  if(props.length>K){
    mapRiskDiscards+=props.length-K;
    props=props.slice(0, K);
    updateMapLine();
  }
  if(safeOn){
    var failed=[], passers=[];
    for(var i=0;i<props.length;i++){
      var ev=evaluateSafeCandidate(props[i]);
      if(ev.pass) passers.push(props[i]); else failed.push(ev.ids);
      if(passers.length && !compassHasSignal()) break;
    }
    recordKills(failed, -1);
    if(passers.length){
      var bp=passers[0], bs=compassScoreFor(bp);
      for(var j=1;j<passers.length;j++){
        var sc2=compassScoreFor(passers[j]);
        if(sc2>bs){ bs=sc2; bp=passers[j]; }
      }
      return applyGenePins(polishChild(bp, true));
    }
    /* Ninguna propuesta pasó: la vía segura de siempre (reintentos y
       reparación), con el mismo juez. */
    return makeSafeChild(a, b, rate);
  }
  var best=props[0], bsc=compassScoreFor(best);
  for(var k=1;k<props.length;k++){
    var sck=compassScoreFor(props[k]);
    if(sck>bsc){ bsc=sck; best=props[k]; }
  }
  return applyGenePins(polishChild(best, false));
}
/* Descenso por coordenadas sobre los genes activos: pasos de ±12% del
   rango (la mitad en la segunda ronda), aceptados solo si sube la
   recompensa de la brújula y —con Límites seguros— el juez los
   aprueba; los pasos rechazados por aviso cuentan como kills, como
   cualquier candidato descartado. Sin señal de la brújula, no pule. */
function polishChild(g, safeOn){
  if(!compassHasSignal()) return g;
  var cur=compassScoreFor(g);
  var budget= POP_SIZE<=24 ? 14 : 8;
  var cands=[];
  GENES.forEach(function(gn){
    if(!isAllowedKey(gn.gkey)) return;
    if(genePins[gn.gkey]!==undefined) return; /* gen fijado por pin global: el pulido no lo modifica */
    var v=g.values[gn.gkey]; if(v===undefined) v=gn.def;
    var rel=Math.abs(v-gn.def)/(gn.max-gn.min);
    if(rel>0.001) cands.push({gn:gn, rel:rel});
  });
  cands.sort(function(x, y){ return y.rel-x.rel; });
  cands=cands.slice(0, POP_SIZE<=24 ? 5 : 4);
  if(!cands.length) return g;
  var step=0.12, improved=false;
  for(var round=0; round<2 && budget>0; round++){
    var any=false;
    for(var ci=0; ci<cands.length && budget>0; ci++){
      var gn2=cands[ci].gn;
      for(var di=0; di<2 && budget>0; di++){
        var dir= di===0 ? 1 : -1;
        var oldV=g.values[gn2.gkey]; if(oldV===undefined) oldV=gn2.def;
        var nv=clampVal(gn2, oldV + dir*step*(gn2.max-gn2.min));
        if(nv===oldV) continue;
        var trial=cloneGenome(g, g.kind, g.lineage);
        trial.values[gn2.gkey]=nv;
        budget--;
        if(safeOn){
          var ev=evaluateSafeCandidate(trial);
          if(!ev.pass){ recordKill(ev.ids); continue; }
        }
        var sc=compassScoreFor(trial);
        if(sc>cur+0.002){ g=trial; cur=sc; any=true; improved=true; break; }
      }
    }
    step*=0.5;
    if(!any) break;
  }
  if(improved) g.lineage="Árbol";
  return g;
}
/* ---------- Panel de la brújula ---------- */
function updateMapLine(){
  var el=document.getElementById("compassMapLine");
  if(!el) return;
  var discarded=mapRiskDiscards+mapDupes;
  if(!mapEvals && !discarded){ el.textContent="Mapa: sin evaluaciones todavía."; return; }
  var top=null, topN=0;
  INDICATORS.forEach(function(ind){
    var n=killSession[ind.id]||0;
    if(n>topN){ topN=n; top=ind; }
  });
  el.innerHTML="Mapa: <strong>"+discarded+" propuestas descartadas antes de nacer</strong>"
    +" ("+mapRiskDiscards+" de alto riesgo · "+mapDupes+" repetidas)"
    +" · "+mapEvals+" candidatos sí llegaron al juez (18 indicadores)"
    +(top ? " · Bache mayor: "+top.label+" ×"+topN : "");
}
function updateCompassUI(){
  /* Visualización RELATIVA: como los pesos absolutos tienden a subir
     juntos (casi todos los rasgos correlados gustan a la vez), las
     barras muestran cada peso relativo a la media de la sesión, para
     que se vea el ORDEN entre rasgos; el puntaje de la brújula sigue
     usando los pesos absolutos, esto solo cambia lo que se muestra.
     Los 3 drivers (mayor peso absoluto) van destacados y nombrados. */
  /* Media, señal y drivers solo cuentan los índices activos: uno
     ignorado no destaca ni arrastra la referencia de las barras. */
  var meanW=0, hasW=false, nActive=0;
  REWARD_FEATURES.forEach(function(rf){
    if(!compassEnabled(rf.id)) return;
    nActive++;
    var w=compass.w[rf.id]||0;
    meanW+=w;
    if(Math.abs(w)>0.02) hasW=true;
  });
  meanW/= (nActive || 1);
  var byAbs=REWARD_FEATURES.filter(function(rf){ return compassEnabled(rf.id); }).sort(function(x, y){
    return Math.abs(compass.w[y.id]||0)-Math.abs(compass.w[x.id]||0);
  });
  var drivers={};
  byAbs.slice(0, 3).forEach(function(rf){
    if(Math.abs(compass.w[rf.id]||0)>0.02) drivers[rf.id]=true;
  });
  var driverNames=byAbs.slice(0, 3).filter(function(rf){ return drivers[rf.id]; })
    .map(function(rf){ return rf.label; });
  var st=document.getElementById("compassStatus");
  if(st) st.textContent= compass.picks
    ? "Aprendida de "+compass.chosen+" elecciones en "+compass.picks+" generaciones."
      +(compass.punishments ? " · "+compass.punishments+" castigo"+(compass.punishments===1?"":"s") : "")
      +(hasW ? " · Barras relativas a la media ("+(meanW>0 ? "+" : "")+meanW.toFixed(2)+")." : "")
      +(driverNames.length ? " Drivers: "+driverNames.join(", ")+"." : "")
    : (compass.punishments
      ? compass.punishments+" castigo"+(compass.punishments===1?"":"s")+" aplicado"+(compass.punishments===1?"":"s")+". Elige ganadores y evoluciona para más señal."
      : "Sin datos: elige ganadores y evoluciona.");
  var hasData= !!(compass.picks || compass.punishments || hasW);
  REWARD_FEATURES.forEach(function(rf){
    var fill=document.getElementById("cbFill-"+rf.id), val=document.getElementById("cbVal-"+rf.id);
    var row=document.getElementById("cbRow-"+rf.id);
    var w=compass.w[rf.id]||0;
    var rel=w-meanW;
    if(fill){
      var pct=Math.min(1, Math.abs(rel)/COMPASS_BAR_MAX)*50;
      fill.style.left= (rel>=0 ? 50 : 50-pct)+"%";
      fill.style.width= pct+"%";
      fill.className="compass-fill"+(rel<0 ? " neg" : "");
    }
    if(val) val.textContent= hasData ? ((rel>0 ? "+" : "")+rel.toFixed(2)) : "—";
    if(row){
      row.classList.toggle("is-driver", !!drivers[rf.id]);
      row.classList.toggle("is-ignored", !compassEnabled(rf.id));
    }
  });
  updateMapLine();
}
function buildCompassPanel(){
  var list=document.getElementById("compassList");
  if(list && !list.children.length){
    REWARD_FEATURES.forEach(function(rf){
      var row=document.createElement("div"); row.className="compass-frow"; row.id="cbRow-"+rf.id;
      if(rf.tip) row.title=rf.tip;
      var chkF=document.createElement("input");
      chkF.type="checkbox"; chkF.id="cbChk-"+rf.id; chkF.checked=compassEnabled(rf.id);
      chkF.setAttribute("aria-label", "Usar "+rf.label+" en la brújula");
      chkF.title="Ignorar este indicador en la brújula.";
      chkF.addEventListener("change", function(){
        compass.enabled[rf.id]=!!chkF.checked;
        if(compass.remember) compassSave();
        updateCompassUI();
      });
      var lab=document.createElement("span"); lab.className="compass-lab"; lab.textContent=rf.label;
      if(rf.tip) lab.title=rf.tip;
      var bar=document.createElement("span"); bar.className="compass-bar";
      if(rf.tip) bar.title=rf.tip;
      var fill=document.createElement("i"); fill.className="compass-fill"; fill.id="cbFill-"+rf.id;
      fill.style.left="50%"; fill.style.width="0%";
      bar.appendChild(fill);
      var val=document.createElement("span"); val.className="compass-val"; val.id="cbVal-"+rf.id; val.textContent="—";
      if(rf.tip) val.title=rf.tip;
      row.appendChild(chkF); row.appendChild(lab); row.appendChild(bar); row.appendChild(val);
      list.appendChild(row);
    });
  }
  var chk=document.getElementById("chkCompass");
  function syncCompassBodyVisibility(){
    var on=!(chk && !chk.checked);
    var panel=document.getElementById("compassPanel");
    if(panel) panel.hidden=!on;
  }
  if(chk) chk.addEventListener("change", function(){
    compass.on=!!chk.checked;
    if(list) list.classList.toggle("is-off", !compass.on);
    syncCompassBodyVisibility();
  });
  syncCompassBodyVisibility();
  var force=document.getElementById("sCompassForce"), fval=document.getElementById("vCompassForce");
  if(force) force.addEventListener("input", function(){
    var v=parseFloat(force.value);
    if(!isNaN(v)){ compass.force=v/100; if(fval) fval.textContent=Math.round(v)+"%"; }
  });
  var rem=document.getElementById("chkRememberTaste");
  if(rem) rem.addEventListener("change", function(){
    compass.remember=!!rem.checked;
    if(compass.remember) compassSave(); else compassForget();
  });
  updateCompassUI();
}
/* ---------- «Recordar gustos»: pesos en la IndexedDB de la página ---------- */
var COMPASS_IDB_ID="taste-v1";
function compassSave(){
  idbOpen(function(db){
    if(!db || !db.objectStoreNames.contains("compass")) return;
    try{
      db.transaction("compass", "readwrite").objectStore("compass")
        .put({ id:COMPASS_IDB_ID, w:compass.w, picks:compass.picks, chosen:compass.chosen, punishments:compass.punishments||0, enabled:compass.enabled });
    }catch(e){}
  });
}
function compassForget(){
  idbOpen(function(db){
    if(!db || !db.objectStoreNames.contains("compass")) return;
    try{ db.transaction("compass", "readwrite").objectStore("compass").delete(COMPASS_IDB_ID); }catch(e){}
  });
}
function compassLoad(){
  idbOpen(function(db){
    if(!db || !db.objectStoreNames.contains("compass")) return;
    try{
      var rq=db.transaction("compass", "readonly").objectStore("compass").get(COMPASS_IDB_ID);
      rq.onsuccess=function(){
        var rec=rq.result;
        if(!rec || !rec.w) return;
        compass.w=rec.w||{}; compass.picks=rec.picks||0; compass.chosen=rec.chosen||0; compass.punishments=rec.punishments||0;
        /* Los checkboxes guardados vuelven con los pesos; los registros
           antiguos (sin enabled) dejan todo activo, como siempre. */
        compass.enabled=rec.enabled||{};
        REWARD_FEATURES.forEach(function(rf){
          var cf=document.getElementById("cbChk-"+rf.id);
          if(cf) cf.checked=compassEnabled(rf.id);
        });
        /* Migración sin pérdida: los pesos guardados se conservan tal
           cual (el rango actual, ±5, contiene a los anteriores ±1.5 y
           ±3); las recompensas nuevas simplemente arrancan en 0. */
        for(var wk in compass.w) compass.w[wk]=clampCompassW(compass.w[wk]||0);
        compass.remember=true;
        var chk=document.getElementById("chkRememberTaste");
        if(chk) chk.checked=true;
        updateCompassUI();
      };
    }catch(e){}
  });
}
/* Imagen nueva: la brújula se reinicia (cada imagen es un mundo),
   salvo que «Recordar gustos» esté activo; el mapa y las estadísticas
   de normalización siempre empiezan de cero con la imagen. */
function compassNewImage(){
  compass.stats={};
  featCache={}; rewardOrigCct=null;
  mapRisk={}; mapEvals=0; mapDupes=0; mapRiskDiscards=0; treeSeen={};
  punishedRecords={};
  if(typeof hidePunishMenu==="function") hidePunishMenu();
  if(!compass.remember){ compass.w={}; compass.picks=0; compass.chosen=0; compass.punishments=0; }
  updateCompassUI();
}
buildCompassPanel();
compassLoad();

btnEvolve.addEventListener("click", function(){
  if(rendering) return;
  var survivors=[], punishedPicked=0;
  Object.keys(selected).forEach(function(k){
    var g=genomeAtCell(parseInt(k,10));
    if(!g) return;
    if(isPunishedGenome(g)){ punishedPicked++; return; } /* castigada: excluida como padre */
    survivors.push(g);
  });
  if(!survivors.length){ showToast(punishedPicked ? "Solo quedan castigadas: elige otra variante." : "Elige al menos 1."); return; }
  var rate=mutRate(), next=[], i;
  /* Decaimiento: solo aquí, una vez por clic válido en Evolucionar, tras
     capturar la tasa de esta generación (esta generación muta con la tasa
     actual; la baja aplica a la siguiente). Ej. con Baja/gen en 2%:
     32 → 30 → 28 → 26…, con mínimo 0. Nada fuera de este clic la baja:
     ni renderizar, ni cargar imagen, ni elegir variantes. */
  applyDecayOnce(generation+1);
  /* Kill count de la generación actual: se reinicia al crear la nueva
     generación; el histórico de la sesión no se toca. */
  resetGenKills();
  /* Brújula: aprende de esta elección (elegidos contra no elegidos de
     la rejilla actual) antes de generar; el mapa olvida las propuestas
     vistas de la generación anterior. */
  compassLearn();
  treeSeen={};
  /* Las castigadas ya cumplieron: castigo aplicado y exclusión de
     padres hecha. Las marcas eran de esta rejilla; la nueva nace limpia. */
  clearPunishedMarks();
  // 1 · Elitismo: los sobrevivientes pasan intactos
  survivors.forEach(function(g){
    next.push(cloneGenome(g, "sobreviviente", "Elegido"));
  });
  // 2 · Sangre nueva
  var immigrants=2;
  // 3 · Hijos por cruce + mutación hasta completar
  var childCount=POP_SIZE - next.length - immigrants;
  if(childCount<0){ immigrants=Math.max(0, POP_SIZE-next.length); childCount=0; }
  var safeOn=safeBoundsOn();
  for(i=0;i<childCount;i++){
    var a=survivors[(Math.random()*survivors.length)|0];
    var b=survivors.length>1 ? survivors[(Math.random()*survivors.length)|0] : a;
    if(survivors.length>1){ var guard=0; while(b===a && guard++<6) b=survivors[(Math.random()*survivors.length)|0]; }
    if(treeOn()){
      /* Árbol (2ª fase): propuestas guiadas por el mapa, ganadora por la
         brújula y pulido por coordenadas; con Límites seguros el juez
         sigue siendo evaluateSafeCandidate para cada candidato. */
      next.push(makeGuidedChild(a, b, rate, safeOn));
    }else if(safeOn){
      /* Límites seguros: el hijo solo entra si ninguna transformación avisa. */
      next.push(makeSafeChild(a, b, rate));
    }else{
      var child=crossover(a,b);
      var muts=mutate(child, rate);
      applyGenePins(child); /* pin global: vale para todos los hijos, vengan de quien vengan */
      child.lineage="Cruce";
      next.push(child);
    }
  }
  for(i=0;i<immigrants;i++){ var imm= safeOn ? makeSafeImmigrant() : randomGenome(); applyGenePins(imm); next.push(imm); }
  population=shuffled(next.slice(0,POP_SIZE));
  generation++;
  selected={}; pinnedCell=CENTER_CELL; previewCell=CENTER_CELL;
  cellEls.forEach(function(el){ el.setAttribute("aria-pressed","false"); });
  genBadge.textContent="Gen "+generation;
  syncSelectionUI();
  renderPopulation(function(){
    showToast("Gen "+generation+" lista.");
  });
});

/* ---------- Carga de imagen ---------- */
/* Resolución del panel derecho según su tamaño real en pantalla × DPR.
   Antes era fija (máx. 760px): en pantallas retina / DPR>1 el navegador
   estiraba ese bitmap y se veía borroso, y la primera pintura era la
   miniatura de 288px ampliada a todo el panel. */
function previewTargetMax(){
  var dispW=0;
  if(previewFrame && previewFrame.clientWidth) dispW=previewFrame.clientWidth;
  if(!dispW && gridZone && gridZone.clientWidth) dispW=gridZone.clientWidth;
  if(!dispW) dispW=560;
  var dpr=Math.min(window.devicePixelRatio||1, 2);
  var ar=sW/Math.max(1,sH);
  var needW=dispW*dpr, needH=(dispW/Math.max(0.2,ar))*dpr;
  var need=Math.max(needW, needH); /* dimensión mayor necesaria en píxeles de dispositivo */
  var target=Math.max(900, Math.ceil(need));
  return Math.min(target, 1600);
}
function prepareWork(){
  GPU.invalidateSources();
  var maxDim=288;
  var scale=Math.min(maxDim/sW, maxDim/sH, 1);
  if(sW<=maxDim && sH<=maxDim) scale=1;
  TW=Math.max(8, Math.round(sW*scale)); TH=Math.max(8, Math.round(sH*scale));
  workCanvas.width=TW; workCanvas.height=TH;
  var ctx=workCanvas.getContext("2d");
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high";
  ctx.drawImage(source,0,0,TW,TH);
  // Copia para la fase de genes: las tarjetas se muestran grandes (2-3
  // columnas), así que renderizarlas desde la miniatura de 288px las
  // dejaba borrosas. Esta copia va hasta 1024px en su lado mayor (sin
  // superar nunca la resolución de la original).
  var gMax=1024;
  var gScale=Math.min(gMax/sW, gMax/sH, 1);
  GW=Math.max(8, Math.round(sW*gScale)); GH=Math.max(8, Math.round(sH*gScale));
  geneWork.width=GW; geneWork.height=GH;
  var gctx=geneWork.getContext("2d");
  gctx.imageSmoothingEnabled=true; gctx.imageSmoothingQuality="high";
  gctx.drawImage(source,0,0,GW,GH);
  // Copia mayor para el panel derecho: píxeles reales para su tamaño en
  // pantalla (× DPR), sin superar nunca la resolución de la original.
  var pMax=previewTargetMax();
  var pScale=Math.min(pMax/sW, pMax/sH, 1);
  PW=Math.max(8, Math.round(sW*pScale)); PH=Math.max(8, Math.round(sH*pScale));
  previewWork.width=PW; previewWork.height=PH;
  var pctx=previewWork.getContext("2d");
  pctx.imageSmoothingEnabled=true; pctx.imageSmoothingQuality="high";
  pctx.drawImage(source,0,0,PW,PH);
}
/* Si el panel cambia de tamaño (resize, apilado móvil, columna de
   transformaciones), recalcula solo la copia del preview, sin tocar la
   retícula ni la población. */
var previewResizeTimer=null;
function refreshPreviewResolution(){
  if(!source || rendering) return;
  var oldPW=PW, oldPH=PH;
  var pMax=previewTargetMax();
  var pScale=Math.min(pMax/sW, pMax/sH, 1);
  var nPW=Math.max(8, Math.round(sW*pScale)), nPH=Math.max(8, Math.round(sH*pScale));
  if(Math.abs(nPW-oldPW)<8 && Math.abs(nPH-oldPH)<8) return;
  GPU.invalidateSources();
  PW=nPW; PH=nPH;
  previewWork.width=PW; previewWork.height=PH;
  var pctx=previewWork.getContext("2d");
  pctx.imageSmoothingEnabled=true; pctx.imageSmoothingQuality="high";
  pctx.drawImage(source,0,0,PW,PH);
  if(previewCanvas){ previewCanvas.width=PW; previewCanvas.height=PH; }
  drawBefore();
  showPreview(previewCell,false);
}
window.addEventListener("resize", function(){
  if(previewResizeTimer) clearTimeout(previewResizeTimer);
  previewResizeTimer=setTimeout(refreshPreviewResolution, 220);
});
function setSource(src,w,h,name){
  source=src; sW=w; sH=h; sName=name;
  var sl=document.getElementById("stageLayout"); if(sl) sl.classList.remove("is-empty");
  document.querySelectorAll(".dl-btn").forEach(function(b){ b.disabled=false; });
  setTimeout(function(){ GPU.warmup(); }, 60);
  if((!LUTS_READY && !LUTS_FAILED) || !customRegistered){
    statusEl.textContent="Cargando las 90 LUTs 3D\u2026";
    whenLutsReady(function(){
      whenCustomLutsReady(function(){
        if(source!==src) return;
        if(LUTS_FAILED) showToast("LUTs no cargaron. Solo 8 integradas.");
        prepareWork(); startGenePhase();
      });
    });
    return;
  }
  if(LUTS_FAILED) showToast("LUTs no cargaron. Solo 8 integradas.");
  prepareWork(); startGenePhase();
}
function loadFile(file){
  if(!file||file.type.indexOf("image/")!==0){ showToast("Usa PNG, JPG o WebP."); return; }
  var img=new Image();
  img.onload=function(){ isDemo=false; setSource(img,img.naturalWidth,img.naturalHeight,file.name); showToast("Lista."); };
  img.onerror=function(){ showToast("Error al abrir."); };
  img.src=URL.createObjectURL(file);
}
var btnLoadEl=document.getElementById("btnLoad"); if(btnLoadEl) btnLoadEl.addEventListener("click", function(){ fileInput.click(); });
fileInput.addEventListener("change", function(){ if(fileInput.files&&fileInput.files[0])loadFile(fileInput.files[0]); fileInput.value=""; });
["dragenter","dragover"].forEach(function(ev){ gridZone.addEventListener(ev,function(e){e.preventDefault();gridZone.classList.add("dragging");}); });
["dragleave","drop"].forEach(function(ev){ gridZone.addEventListener(ev,function(e){e.preventDefault();gridZone.classList.remove("dragging");}); });
gridZone.addEventListener("drop", function(e){ var f=e.dataTransfer&&e.dataTransfer.files; if(f&&f[0])loadFile(f[0]); });
window.addEventListener("paste", function(e){ var f=e.clipboardData&&e.clipboardData.files; if(f&&f[0])loadFile(f[0]); });

/* ==================================================================
   Metadatos en la imagen exportada (mismo formato que el Studio)
   ================================================================== */
var META_KEY="ColorEnhanceStudioTop75";
var CRC_TABLE=null;
function crc32(bytes){
  if(!CRC_TABLE){ CRC_TABLE=new Int32Array(256); for(var n=0;n<256;n++){ var c=n; for(var k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); CRC_TABLE[n]=c; } }
  var crc=0xFFFFFFFF;
  for(var i=0;i<bytes.length;i++) crc=CRC_TABLE[(crc^bytes[i])&0xFF]^(crc>>>8);
  return (crc^0xFFFFFFFF)>>>0;
}
function strBytes(s){ var out=new Uint8Array(s.length); for(var i=0;i<s.length;i++) out[i]=s.charCodeAt(i)&0xFF; return out; }
function bytesToStr(bytes){ var s=""; for(var i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return s; }
function genomeJSON(g){
  var o={}; GENES.forEach(function(f){ var v=g.values[f.gkey]; o[f.gkey]=Math.round((v!==undefined?v:f.def)*1000)/1000; });
  o.order=g.order.slice(); o.gen=generation;
  return JSON.stringify(o);
}
function embedPngMeta(buf,json){
  var src=new Uint8Array(buf);
  var key=strBytes(META_KEY), txt=strBytes(json);
  var data=new Uint8Array(key.length+1+txt.length);
  data.set(key,0); data[key.length]=0; data.set(txt,key.length+1);
  var chunk=new Uint8Array(12+data.length), dv=new DataView(chunk.buffer);
  dv.setUint32(0,data.length);
  chunk.set(strBytes("tEXt"),4); chunk.set(data,8);
  dv.setUint32(8+data.length, crc32(chunk.subarray(4,8+data.length)));
  var off=8, iendAt=src.length-12;
  while(off+8<=src.length){
    var len=(((src[off]<<24)|(src[off+1]<<16)|(src[off+2]<<8)|src[off+3])>>>0);
    var type=String.fromCharCode(src[off+4],src[off+5],src[off+6],src[off+7]);
    if(type==="IEND"){ iendAt=off; break; }
    off+=12+len;
  }
  var out=new Uint8Array(src.length+chunk.length);
  out.set(src.subarray(0,iendAt),0); out.set(chunk,iendAt); out.set(src.subarray(iendAt),iendAt+chunk.length);
  return out;
}
function embedJpegMeta(buf,json){
  var src=new Uint8Array(buf);
  var text=strBytes(META_KEY+":"+json);
  var len=text.length+2;
  var seg=new Uint8Array(4+text.length);
  seg[0]=0xFF; seg[1]=0xFE; seg[2]=(len>>8)&0xFF; seg[3]=len&0xFF; seg.set(text,4);
  var out=new Uint8Array(src.length+seg.length);
  out.set(src.subarray(0,2),0); out.set(seg,2); out.set(src.subarray(2),2+seg.length);
  return out;
}
function parseConfigText(text){
  if(!text) return null;
  var i=text.indexOf("{");
  if(i<0) return null;
  try{ var o=JSON.parse(text.slice(i)); if(o&&typeof o==="object") return o; }catch(e){}
  return null;
}
function readPngConfig(u8){
  var off=8;
  while(off+8<=u8.length){
    var len=(((u8[off]<<24)|(u8[off+1]<<16)|(u8[off+2]<<8)|u8[off+3])>>>0);
    var type=String.fromCharCode(u8[off+4],u8[off+5],u8[off+6],u8[off+7]);
    if(type==="tEXt"){
      var data=u8.subarray(off+8,off+8+len), z=0;
      while(z<data.length&&data[z]!==0) z++;
      if(bytesToStr(data.subarray(0,z))===META_KEY) return parseConfigText(bytesToStr(data.subarray(z+1)));
    }
    if(type==="IEND") break;
    off+=12+len;
  }
  return null;
}
function readJpegConfig(u8){
  var off=2;
  while(off+4<=u8.length){
    if(u8[off]!==0xFF) break;
    var marker=u8[off+1];
    if(marker===0xDA||marker===0xD9) break;
    var len=((u8[off+2]<<8)|u8[off+3])>>>0;
    if(len<2||off+2+len>u8.length) break;
    if(marker===0xFE){
      var text=bytesToStr(u8.subarray(off+4,off+2+len));
      if(text.indexOf(META_KEY)===0) return parseConfigText(text);
    }
    off+=2+len;
  }
  return null;
}
function extractConfig(buf){
  var u8=new Uint8Array(buf);
  if(u8.length>8&&u8[0]===0x89&&u8[1]===0x50&&u8[2]===0x4E&&u8[3]===0x47) return readPngConfig(u8);
  if(u8.length>2&&u8[0]===0xFF&&u8[1]===0xD8) return readJpegConfig(u8);
  return null;
}

/* ---------- Dithering (previews en tiempo real y exportación) ----------
   Un combobox (selDither) elige el método; por defecto Floyd-Steinberg (fs).
   Métodos:
     none   — sin dithering (redondeo normal).
     bayer2/4/8 — Bayer ordenado 2×2, 4×4, 8×8 (BAYER8 es la misma
       matriz que usa el gen de dither).
     bn256/bn512 — ruido azul ordenado, tile 256×256 / 512×512
       (máscara tileable por filtrado paso-alto de ruido blanco).
     fs     — Floyd-Steinberg, difusión de error en serpentina (sRGB).
     hybrid — blue noise 512 + Floyd-Steinberg en Oklch (sin mesh):
       se convierte a Oklab (la forma cartesiana de Oklch:
       C=hypot(a,b), h=atan2(b,a)), se suma el blue noise 512
       (±1/255) solo al canal L, y la difusión de error se hace en
       Oklab. Sin mesh ni capas diagonales: esto es un dither de
       imagen, no un degradado.
   Se aplica en la única cuantización final float32 → 8 bits de cada
   imagen graduada: miniaturas de la rejilla, tarjetas de genes, el
   DESPUÉS del antes/después y la imagen descargada, para que lo que
   se ve sea lo que se exporta. Nunca lo llevan la celda ORIGINAL ni
   el lado ANTES (la original ya es de 8 bits), ni el panel Diferencia
   (compara la versión limpia), ni la LUT .cube horneada. */
var BAYER_MATS={
  2:{ n:2, m:[0,2, 3,1] },
  4:{ n:4, m:[0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5] },
  8:{ n:8, m:BAYER8 }
};
/* Umbrales Bayer normalizados a [0,1): (m+0.5)/n². */
function normBayer(mat){
  var n=Math.sqrt(mat.length), out=new Float32Array(mat.length);
  for(var i=0;i<mat.length;i++) out[i]=(mat[i]+0.5)/(n*n);
  return out;
}
var BAYER_NORM={};
for(var _bn in BAYER_MATS) BAYER_NORM[_bn]=normBayer(BAYER_MATS[_bn].m);
/* Ruido azul: máscaras tileables incrustadas como base64 de bytes
   uint8 row-major 0..255; se decodifican al cargar. */
var BN256_B64="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StUxQLZJQ23EUYI7t6teC6yyeIt/KWMznI6IgWNLIFRvxW+XXoZUvSI/rl2XydaAX3tCtc/SRr7Vr5B2aqdSQW87ISy2jGrLgK85UiOatVlitCF4bFRsZsRGRnpGaLZsjYdyv5C10oxYYx4+S5IyMDotyZqUO4bBVZ5yeZS+USK2T86EW+ZQP2GkwN2oPH+btZClUlx8RM+ncmZsGITEJ+LEQSWbwD2ttJq5xiemNWc7jqCQPC4lto1hY4dqUVtQ0MGfsjAxSL/L3jy0MLNkYEiuqWhBzVSkYlpsw1WttUiaVzszgLxRMXNVR68rWL5TbzBGNpCXdDA3wpcT1Vt+R33HOaS7M0w3pzpKo8iPi3xleJ2GOJxHLFqmb6ehnkZKez/DzbjFkJ+BqTFwmsyssEeAdKhILVtpOsOgf3uLOIElvbkmI4uIb8JT0y7MkCA1zYOCbbNwQ9ZURNyguHmuNJ1WvrOAPZKj2lSRg6GKNy+wveBoQUk6Tn7lT9JWaK07r5U9IyPLRC/LPJ5yp32PE2E+n8dSqEAjo72+ar3UMmA1ZV2iwGYIMG9tg5/ucLjL3qgTob6ZylPEsW9DYjSQd102czKbkpzgRTAnfEI6wZKEktx3fhjDm6B7HYk5nTbTu4JT49dPWHutQNhiisUt1GB+OmLHZtXBcFgkLsG7JITfbo7FLbGRNLjtqHVTK4e8RnXAuJ694jwgxzh7uSSchZEfmda2mC1dUKqJq16kald3QtvUcNRfZkBsgXHUVovLVG2sh4R+QzFqPJ5HlXzWi8nTQcd9rWxvLHBiuYNuN69ym0UmMrWgNElhkt6rnV7F1tK6Uyq/d3bCPDU5RSqEfpGAbrKkVUm9gGhscz+ocmEsyZVGKz5qvqq3Zyo3UyyGKzmra9CkP5qDMJBmPmhbq20tZc+jNFCRkrFg1VaLeLhXe7ZAdmpIkSGF0befi9ZwRoSId5AKO0uMhs2oanTKtTKPYXrZXoK/uM2doWA8mZ+uhDberSY/pYpaUaqJjEAjt6TPgaFShk1RhECRS2+cGnNISbuPlLGiG1ZsPn2zpkqbLERohnZJP1HGXTiKLSynMU5taqd9oVlJnjE8gZ6CML96dr+Rpi/d3Z+jTWFlbqm5LYOYJ1nM0K9sW2+cY3uKpM4efYitQos+N1eVepN5k51YQlPSZ+Q51VZGYzZ5lLNlhIFn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RJZ0jyhr1tFJNqRF0J9sGbuFXjGnbl7RxoObZHmHsnjfeJcvucKeROK04WkhRZU+b043KnuqUL4kYsdrcm4soFDCtsW8m16mxlFvZj9v3q1luy9tgD3FYLGyroMnJJyffCeLIDlLEbzCpGyZTx+mnDyVoKpuVcK5NFygSyGqMiaCraXKo0nLnN9QiqyViDGDdJQkwGxnykpXclgucKhVSCyTXM0qyTPIjSN7xNWMkDCqUabGvdQmi1nGtThfgWc2PltTYO48rL1VL6qfRUdar61EUD+jnG6Vdot2qh6dbLCkfMsaTWtoZJNuhZaCgW+tfjYnv0FGZHnGzJSzYph7z1OBrXWaiY+FUmmAuchsvaqSYjtdUdlla2ZZNnx3bqNeSGGEmDa4RcUwjWuTm4hbpYaqp1AvxkBmIKNXsdnDf6mExXBpo7JLbKBM1r6G0Wgnkr5UTr9IVy57tZNerkSFSMHJY0G4l558lXBGP1de2JAhcVPIOVPRW6hreGx10j5MuTJfgj1AocKHrCNLwJ97zmwwc51hNWqzlGuRfT9Ub5NiKtU2VneAgDAqjGo3GqvFsFQCl60tV0/Pqzhx24+y1M2fYOVLYzyaPjw+Qlt5J6WCdXQyr5ld3TLKRCiuS1lLcVl1oXDLOj6PmsS9vcYmjCtIoZ/EqRYwKU91xsSPiCpJ1H58SZ2AmjlFbXjbZTiAfqOpf0N7JleEm0LpwyQfjZxapzlzasIyOC9xljBfpICEzlptjGRl0LN8viuuNE5zaD9lQ6l3oJCJRpaFgrFHVR/IP22qKNuhuiazP6VvZVa+ZZKmZnKUujt0WmnKUrJ0M1+Sb8NKJrWbdSZTalzSxJQ0OWU6d16vP9GwLC99qc91JYwxnVWPpVrYVIpFjJWVoZTbL3vjrD6DMYWsY5cwjEU+p4WJIatjHqurKY9o3WsydFvpVyh8UqLghWTEjYekILY1qs1kTaUeUrCXxbm4pCWg2agwvODRckU5M2LRRV27bY1X06x/nlsjKltmPCWiU2V/vS2vOcHfUmFb2ES7IUHBcLsotbCFg5NBVYwmiVmbeIFDh8g5OMBTUlF6xkO9RkFHdNdGpb8zq0U213rlLCl8UkRP0cmoYlyGpZC2s8N9VDhnL5hWc4ZCjMCfdiBGyxONxZYqsGKP2nhIhH3sZ61F1Yoj0Zo9QljWyop/bjiNbXfT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";
var BN512_B64="QD+4gpCPnx9vMmPHiDaMPqrIy4q5Yj2BdJnST7k7ZbhXoHR3vaGjccTLOk1llciM5G/Sj6BEg6vAxd9NxImqWCAmxLhRbU9AwJ4wRYXB0kSJHzc7aFqjeGPLmKOrYscrYUcp2TFvrJSzJXkpScE2kytdy1lXL65HiDk90zuJfUOfsuNZ3kBGjLGsjQ9fsoxYtEmyMm1g1bChf1KwuTI5S3FSctxt0oJm1X/Bb+m3yCs0LYRx3FlKv1egSnYhi7qStKN9wnZBkaRWUKt/grakzE29mUFHeqpRlONGQtNNvF6nK5XCYphLQiaDiz9conRaMDakSc+bYqRKZoWjTHVHSlRdw2Y2z5pOSETQh5XEYL9ooLcroKrGk3Ezo2mjF0yggpyKtLqsmVEwtWteNU03cVh1fUZygI+GI0y0mGBt1LBtWzqvjmWWfnyXqn9sUFfPPSyJVi+FrjGITpm/u7BRiYi2lKU2YnSp0nCIsEhoRj+ixD+dmp+Uei2qRXfUj10zVYq/uEujmLR/gnnQkkWJxrpjvzSumix5ZmhEr646tKNciHCZTo5IS86SadBvTs4r0TC0czbObCmm2kaM0j2waCI9taHIkk5sbGA8xzy5tIWofo6tddC6Nc9MVm+8gKktqC1RTLlmqaObj8EtojOcfNnHM8tDYX27WsdZcdKxpWsqRWOSxjUrk0OogcFydLA2Q7ousZXKUY8snCpjW0SJXzurRVZOi45nH2id0tVKWoVbR07LnXN/WYVHOp6Yd3s3shpqXaiKR4WUyIHFXMfHq7JsvnSDZY1xlDY5vMVWLjK8hWCuhHAtW6SSdECZKtmSpoFduR9opbRbOetBy6EuUUczlkdvdDBcg3Jsrj1nq1pyn7Apa2heX75piiCcdFaKq7DH2LJkqphgezJaS9DQqlLKTbu21LNCKSTMPK5fr5AgZI93OrCsQly0TTptU2WnUqqeglBwfcsyYLEtjE50IkqyzznE0phKnGBqmk1q2nKdPa50nDROUj7KhWJjbWmzk8a0Ultsx7mJw5yQnjeOPTSuLaNHvyKpw2rNMbCyOpGfhyuiNmpSX9aQbIy4tsLSwrGAVFNSY7yPY6+1Qz19gDWGkLGEtWYxmol0kUk9XLWvfEfDxz6eiMtujaill1J5vlJCeHVp3s0/fpt60VDKU8fWWGA1uziDU8qQPKvMiK6kibWjQqOEcY6ZQli8MTuZO2mju7NTX7eryZeyXMlhTZtZRGJ5czNERUy7NWzYcG6wmFBydZ9jq2tmYYl/OGtQcj+4V4Vsn6J9caxnfsQ3OY84mDdOwYSbUbJL1zNIxMZJVNqHpJyGqDZIPHwuNWNhwNtgybuJfKswwkViwto9ecxHho4xlnWcsZC/IbSTzMSGjnjCNHa5tWw9XsRZdEjKg2U2kGiru48qh7rQXTVLOJSHds5Am81Zhj1tgLOCtHM8hTFKvcK7XaM5rWA9x3Q4kkmQvVleSMVzPYHTRVvcVEq+ROXG0p6jMcLG1paMSUGUup1jjVUlgdg8aj5+YUeOuKbB1L6/NMklhMOao5VoSa0+ias8QMGvpHbJHUZ/JXSJPU9a0VSMVU+gu0tMfH6QmcnDOlA82VCeTkY7xye1PRs/WHKLnJR2clmBRH9WlECOgYLThLxLWZsx1DCccK9i0ZwsL1RMu5qxjEKLqtJxPVhIXoyajCfSU9IsmrjI1rpZQJSIdVxDdnNPMCKLsY6gWrCyWyRtwUFRkFK3aaU7xF9WeaxjPrSDzT67mcOaQWhyV06QI2nCYCAvylVYw1reRW18vYS1wDyaScWbfFmVzDRbrJd8mGRObNJedENFky6vb42Q01JTvIpTJrhBJc5UL0hxfIJklWNgsnWCT4iTY3KxV3stoznAXpGpe1FZmb2ulaChWEfDcZG1ozi3qCGLNV6seqE9RKVQrlQxM2M1tzZMln6DpYh6STLRy6CufISXU2uIwHY+TkZIwjCoSFhglKqfmUKUOb83PEtptig8aUw3kjioMmdZmqByVsWzXFfJW0B5hy7Hb5GJyLhsL5i3wJGQmk05fsJSS8t8LYAmw6mDxMVXQk+ZUI1+gbKZjZJ3bMCYYCema6Rrk0ZBhqaXnDaqWYkxPpPWOU5Wq3mzcL8ef8enT0iXOk2Bi79eSVeFcB6CpYyGqpBnUkd+Y7F1oKvBgnFhmy+Riks6Z4hXo5ORZDl1X7XSM0SJsUh6doqkXCg0m4vOIsa1pK5Bc0+ZgYyyzLEebVORbHGvr6hcfIQ4mJ8fXjUhu4fJdDNeL1GTe4tPYXFP1rR+lFCffCfCoLjKmLvIZLqBtN6C4UPDpSeayeJLcZ7NXkuzyibUmCt0XG3Ro8eskJ03PSmsV3XO0LAjbMyoKb5IVDXNl3Bhd3wtJzSUhdw2OJM4P8CgezmYUdBaK41fuG6yqaySnKuHo2/GVTfIvW6MoUlFm3t9PUVbupvNWX6ZezWWZ5ZypodAUX+fRbpMqsQdzHVoYdWLZix3mK9iYtBTOoeJP4+Cwi2sKEDDVZGiaWlpS3bFS7p0ar2QntHZSIy+J7VGlzuTkJgvgFSCwzqCgz+jnoCtkThbKqCIooU1N6J8PXgdXDiBa8uQ4GjGTKOwzmmvxXVWkKM5XICqSoSYlEI3R7GFYCCeZ7V8QcM2eLR4z4jEv3vNymY0uDXSk5yG0rGOPX1so9pSYtdls3w6xqtElKmWc2Fqqk67dEGIRGc5fDKTvb0+jXt2iN9hRa4jbb52UVk9sV9UUZdWn7i+WKg9V1CZ27F/WmrPqlfDX3tttM5NdVkzhr9SK192Tr9ZhcG6ttU1llt0ojnBU42IprBJXay3taNprEelJqadj6akN7GVPuVFRFxRYTSPbp5nrMZuOLJMOMvKI9BRu3DPMKRk3pGrgxR7Voo7kLcrbplCkUBZR3+nUb2ykEavOkC1qrFzyGizhIaMfo5zoW+6t7tMuquaIIs+QsqEU46EW8y7mrx7wKGV0iXLbUQ1RWBotU5Ms064gUBkPpZsZKNZpz9tT5TCy7/Cii+Kk3icY7vIbadBiHWXXSxht6u2jnGYsqNIVotBbGeZrXGTqL1+nUStlM7BpTDIldpeqz+8ez2NNIDPYlmhclxVXaNcLdG9WXBPwKTRK507breY3cN4pc5Q0SV/xIqVgC5IhGmInlBAvY1Qi0OrW9FVrrY2m2xNm4aFTXWwZsJoMrN3OUe5TmeikcuxUcOHUmR0NjGRtDcuj4yWtS1xh4JEUKK+Rm+VppvHkSRCrKM+U1ixM4CIbHeKkkiUpb55QbKYpqjO0mokXirVrYKjb7manj8mvqKjOZ2dYJ+1pL5uqJTJ1TzRqmS2vW9pMlqOxVe1LyrRKbqSiaSVqY/TenY+zk2yaDt9MFyTQzdhqjzFwi5JfmtjhJBMdXVIg5Qsudmykb5BZ8ylOUumjn09TH5Ypmq1XrhOcW+ud2CsXFWsM2m4wS3ClouHKc2KOse/jkRTU9WmZUd0j3ughjuzsKJvLNXZKEwviYymTkdussmdXoko1T9wkoi9bbuQjIBli0wyUb9FMchBdcpDe5u5dTgnudZM05pZaL09cGWKtoCtlFVuRkNwvYt+uYFstXOZIsRYWryScTeYQJdiwHLyjnRRcrUcTlhOILq/rKulJb+8onFYxtA/KDnGhXJfZdl9OmwrvIO2r7M0Wc14cDBCrDY2hnS/OsutVrt3VYzFUES9mFc7MVyvgnleeEa6iGiof8wiVIFIiC1IUY87VVu+nGcju4+lX2BSoXS8as93nENCkJ7Iui1CQYubVWeBYmT0bnpR26GZajNDaIZHVY+xy5Y1pThhOExcnkGOz12rkcpcjWK8L6YrVaGVbFuEgla+a0RFN7u8T4iiXkF11mWuzEl5bsSFcFXFNMKLgXmoQFRQPC6XmS+RcHOBdJe6slRAULxecyaBX2iWvY1iYiPFrDSTi65KSKdGd361kbSOk4+znbs/LHOwWZ2fp3m/ooqficGNsq8gT5idbsNAcXs4sR6mvDJySb2dU8U3ImItiqLElCy3gUqZfGCng1OkX8UseLaDZ2tSrI/RxeHKeV1HgVpcnLm1t7ecNbKrdVOBqjtTp6Jft4lbG7Rke5XMm6KGhkJzh1COlIiqZmhCqZGJOJjOLmJ0VkJ63jxFv73KLbaZmdDjzG2geXhAdXEqz3aeOYiZh4GXuY0cbGd8ozq9eoWee0drUTi2jUBbTIXBo0e1ZbDLf23WurK3ljGVTszGvl2/cIrQhjemzkuNdYGdC62CULKVcsg/gEu8PEVtvKm5GqZgnGvCcV+LM5aiZVrNzoUyTquzJoy5NJXJLIJOWFRIOyqJSpBUcmE92ZuWY040aK9rKyydeGKEK8lvcDSinqdoR6V9aF6yMZMnWN5HNWq3gU+SGsLBKZWWbIC3kpovZaidSqOzQdOsoNRPoIehOL2wp2t6sYhrpGuOMjVUOlJamrlcVHduOMe1Rs9oY3JQToK92GM1dWtxPEJbxzREvmc/vV13RImyX5+CXFKGbaAmcDFpiZ65SdVyukGR5KNtmbCadNPMcJGMUcZSWKo9rciWI5W/xcQkPYmkf0w7S7TTuMaPrr9qmMMPcRXAZp7ILIuttKi+sXKSUjU+xtdtSEnbWXZbs7qvIMKzfBmboi1MQ39WQEa/wTTHbDmJPnJeSFJTQMeyO0cwptPGx4eVXmklxrVtSyM/Z6t1qn1JvmIql7qVg2qpOGZ4S5xaUVqneKiDK6i7QXOGTZOzskaQpIV1na98RbibtZ1+pSy9ZTVPq0Z+VWWtt1umdMBxQkR8exJZwrywi0fQM7+PgdYsqErINWaod0VlooReenN9rDNpSFq7ZDnLhIBpVzVFmjdeZLSVVXdbscvOO4Z9aD29uziWqKa6dahrL7yGWrHUcFPBxkRlhKWNLLxDdnZSr587OKJrKnpdq3Bkk3qOjpuLn8KzclSTtTiqVZFWnkBlbL0zpYGlupA10FWWi3RFilVokLBbXLC9e26jiFkaXsq3nI9ew8ZKvDGRm8A9XToydNCimF2En7NuUFSDf8mLgD82lcpBjcCkab86ZS+RVmhgsYAgiLaQrGdek9qKfVlQRchluZzUPHqZzC54SbCTWZx/kneQp01azlyCIL9F08BaftdJMoueb2J/QUiS2Vk9zkmWh2VlKWal3qOXw5RzjNSfO6nijcK3QCzVriosm4xCs5/JyF5JsmS3xGeAcVGoQjY3tik2Xji7vYo9R3hvsII0eIuWJ5o5qaqDrCNcorikxJ9/b2HAjyzHl7h2jY2RKdPXfCi1NCFuiodrUJllcc+MZjSGt01akkuZo5u8RWVjkZc90GGrO0W8JFtRkHlcUYmzZ1TIPNeWiLiNVT9kakqWGqaWnC5mlqmTbHygIzUhrXV7dLsnNyqdsJJbmKiyUkZYp7yPPJ12mJmDuUlakYUjPq2hZzE9SoQqzCuGnDRpR6ZEzFI8jaOpzDZfnDrQdpF2hIm4ea9Q0DymXi93dEOxUmW50G1dRH+pkmdoe09ry0eKvUSSNM1fGXOLiHpwfcOsXFNAbYg4vIKobiUxmVlwctGAwyuch3ipvE8WIZI2Na2LhnY/qklRwzajgp2vNS3VOldIZbBEkr1nh2l9fGUnnCd0iX3XTWPExzDPt1ewo27DOzZOoz6EoWNsM+c/c6tjspO+t6J+kzdhPI6el6xW1yqJm6o3lbCCObeCUIpKfWC6Yn3CaayDoHK4jV7P04vLZUHEU5tBsT2D2Kd7O8aPiCohr2eurFVhpmClOUJ4t8o0J2HJmZeKXEDEOLvAtqNbZF4lkSy1kVBuV7J1PzOgvrJ1cH6lpNS/SKVHaGhur3hWkDa1gSVply/GspI5dGSLWZTLo3E3krGLfTFDZbZgaLa9X2xDjr9FNlszceFMtaq/ZilaOJaRX0qBjpPVmn90RKmAvZ/RYYouz6/CYIyaMGaOOXvLmGtEWMC2TnnTU16Af7OUc0GzZzCn071O1KyQg+HZaIqbgqsrL0Gyd7l0iHLHR6CeYpGsw3Nrk3TSjKSNtjK9UE9jNFY9gX4szR1pVcSjX25LsHiAv87OvXqpWcCncHFFY9W2YjuJvV3glz3FqoIjMUxXfUj0ii6YZndpqkhT3qxTTsNvfImXRZm9jVCoNbeZMnYuQXmQPsWNqb9/bXEzNDF4frqkTa+ppH1qdbKrfy2nVjO3g8Ywy0nMZGSZmTOclsJbfUna296obmiOPlt+pq2AestXijykVpy6KkCizX2cGVu2L4VhsME8NsJTcTiBrjzXV4p8USnHhYs+161qdjSuHpJHoG/Brr52LlBtx1uUsZhutR+LkjdAvkY9s0PJlmyFkksurDFBRnxOyUzENJYvtp+Ziku3wraZiZKCysGApVi+cG2OPMvAwmdpY3ORIrWJhqK9NqmQjT88tZqToLeEVXtWz6HHN5C0zUO6O8pDUqwyOeJ5d0Z4r7gwLVBDumaHszOJw1VKH1a6mZ5txKOhbUtInY6kx1VYq5OikYWsRWlyScObdchliKNByK/GfoqgkjyAubZxkdJRW0kpRV22pLadcKqtNcaH1Ty+XbUzOpScykSgPJ5Fw7tQdYGuvphWcK6hOI9td0lxcFhDRixydjlpQKB3GpWJmx+8b4ocabooaZZoaiuBvDlfsXSfl6SrlXRBQGjgPVfSMk2emMqNOqg0TKmNk3NUlFLLrnYmmUhtWcGkyFcxML+x0KZrP2+tqJ7TbmyMc3mNs0rdeXiISlRyXZGOSLQvTz2fvdOwTkpGamxnwUpXwqxTfonAf5BZWEmip2+LyXiDSs1qqYLVSFSFOa+6M465Tm+ayDTJxyzAorZVpJInuYdpJ5FnmJZChmq0UE9vQpynK25+14VeeDnDtl8srzA0MHmuMmyql4tKSG1zfUhKytPITsfOks5QYHGHnKF41jZchcgxakfIqXR8c5u9j6WZ11h0rXhDri02YNA2vJWIVEcybLbNximVWsc6tGDUNqCDrE6ueDkoYVaQwU+WrU0fsDjRYG9byKypHU+6idhiLV/No6ByR2zCfzqoamhYiXZNRWZkWIJvcVWBlspex5NBM6zCsinDRF9xtZ1yOG4zf7NoJ40RdKzJWZSUSMpLOW6Pel6+lpk6UKNpgo++tnyjcpuRXTmYx1abKVmZloBIwVabcD+nDlJZjlqXjG900S2+LI1na5bdRLs7eEa6q9WzlHoxJLnFy7+MXjUsRIZVS2FqjmfDV1bHQGaeKXd3krmxVYmNXW2km3dfiV9r3H20lZYulrPXnj3ZfNeZbUE124ebWqJGzDuNOcqlZILCSHQ/ompHjG86foJzk7odcNjM3UZmS1Q4xj1/laREVKR9vjrGYS+JVi5/UTlys1WFn3ZQQH8xzsSfjDZZMrg8M1psZjRktH/Cn1hDv7PaxFN/09NmabWxoVd+gKDGJ9V1em5limetO81qxJHRRXpdRzyffydY0K2Ro3hgSHLFW7fSPXS3XTpmoCh/vZG+MpKjLJ+xrMNiOE65h9elLrAsc52MY5Skj2KnrVqtScxPiKcvwVFKfpDDkoHQOi5yj5a4Ss6BbZhwtKe+vLVNrdBMRrwytSrJMi02tEyxUqXPSrdTPJ1MOaVhkbNurGCnl5lxsKkvMrRBn0zXklCKUbe1uKizjWpAOqLEkcIzI8Is21Fea5OdYmq2lLS3TkSRVHXGo3ySe6mIQ352lqCzxJG6lkOKbE4qtVJWNl2oZFmGnMRQdDqYsW5gakjL0Jc5LFDKvYmC20lDsNdtlB9/n2VLxai6rn1gWC9fo4fZZI1qQaeOscfNO0xzaFZScqLdZNNfNi6FspXYw0udg5CrxrCsUKggfqFIkL9Ppb6+oTGYqpt7MkjLfdc3R6OtlYEqX5GJgDdiXB5VYZedgUUrY1+rct5rR62KrjTIVM8wfpZ/dH8ZdKAuT0KLtmunm1zCUYCSVbkvJF6axlluYGV6ikVTsKE4jnXLjbyuy4akP6i4PcvKIsG8poZuhnVlvDmZg6q8jjCslz+cecK+H7hrdEQxXWq8kDZYXEy6hbrC49ZX4EZ5VMN/bqCWOo+SX0UhycGCtDo3t3Z2y6ZmgXHJf2Ns3rMuR3BcU1zwQz+/ZKhpLii8vJulv4TBdFhPpEpJd26cv79AST29YquYXolDqjJT1bFXMjmEnjdQt8YdlJ66q4tQlz1phWp/sYhIgDNTyapnYIjMcGqzpLhFRj+rrlfIgpRtkayaZkK9udlIkiuxnbiJQ3ZuwLpZmjCuOpDKdDy8XGNyiKRHTWyEcqoylC+VwTfYZkdUbtymREC7KjK9YFMr2mSS0ZmEiW5/plF/jb9qLLzYZUVZaMk8giRLLLkzZ9mtoJOASY2Ne3vQLrvVoE6XZJXCRKCqO5iIVBpjpp+QtJlPiU9qpae4gY+vfC+FYXhOa4Rui6U+psZXZ3strLGKRFU0QGp1iTJTpVCaJJ5Xc7KTWKF/U0KWSld9zkSCgzSmdHeSWKtoncBbWDtlOJ6HTM/OM1CKOFt4ZIBtfl5Sgqhas8Vqpp6nocNEtU2JScYzVKkoZ6lA14Q7TW0fcGVesrWauM2TdJTRpGzKg0C0eXs5O7iWWsLHaWx32lnDlLhzR09xztkonrV1vmQ6cyzBlr2JNkjEgHtBUHKMhXzLYmq3NjK8P4hdOoo1VXBbVChlx0xbvL6u1JxdMa6oZWNexZ07s0ZwNoCwktKFsFZYhB17vXA1lLVtiHd9So1GSFNCkcJCdsSdWV22dbqutZNQZZxtN8eJG4dkdkA1RUc8Qrhkf4CWRG1Td0N2vrFDKcs6zT18d1p6d5yW0nfHd0+Aan57Xa2UiI5Tyz1NaoWYvU99gNxqy8c3lZvKY3e4b5nGQmNzhp8tY0rYW6ZPWG+gx9VVhDxildppQCvDqyLJYaGwqIKmetg1RzPHY5y8wjywmX1ejqVAbVVSQD1328FMXj64TD6ElNBLwo9yp7e6YqysQjaqMmaqioZBwXSVoIJIWKFqzmyCd1qlRYpyOGVXomK567qfv4641ajBWUOaa3NTLX6HuTE5oDWOMzoscseFPFFbzHPJqSrHmk9tibpdyzR8iZqocF6kmdp9ZVAz4dt/JX2QlHsmZCfNz0I+WU/DuzOhallcq31JoEe8aUR7JZmnsLy5HpaefKlcnUKbwldWy99Ts9K/0Z69gmp1yTpDb36JjEJNON2ZQGJxsixGU5C0Y49GUEGLmkiYrYnROiWnUq1PNjRSxpiWmYfHiLqVok8tQzkxQUFgSla6nmeobqCjzcc7MrSWYntySKBbHawnWKSQd3gsImK7r8FFvVhxcXJWp0jkNYWfWFd5j5KPmWjDvXeYqSZ5z393075himBYgx0uQjtPg8eZZM5NL28tNquSzbgxjVN4oNScwr1Ei7C6u0rGqIebTIRqwZ/PsZMrpWxtzbydZLqQuY3VfjPCuZQ8enySJporZN1sT6JKR4y9Qrg4oJZen8ZglpSwTaCniYRXWj+nqrqDREG2QrJ2uI5OplZ6M1dqpL5AkUvHdGWVlydzMLqTa2B+aT5ubzlWzKHMd5/IP0ekULJxW3pBZrSEpzl2V12czFg1fl2Kdi+GMU1HksVAYYiPLqRfa5mHPjY0gca4anMxwHqwWlOwU7IonsCVLoYzJYSMGV04UbmMX1jG44eeSbe1Ql44YVc5WEuOz5Wtvboxm3xmmJBypEF/UU0+iWmmQ1/UbaF5QFacSnVAsKBH2m66ibGGpz5sun5BU3S6gjFsSWGKqZWDMZ25rzvRWIKYckDNXdiEwSM7MbA8hLV6gECHS4bIr12dgoKG7Iezho5WHLeads5YhkhpqJGni7xBnztrL0yPZ2Y3kVhCX4M0sjxjNbJgMsHA0nhEep+HK0yXK4zKfEdVRHQzIJyLh6o2PFnqO1AxyKLNgGu2upeGsk6kl2pcOzgsqspGQ8/DSpRfiriYwp1xXo80x2tXll0yRKOos6FzPMCtV2KbhGmFoYg/hr9sraJuTn/MrHUusSCLKnNPgbKJXWhieGFvyMBNX7G5dHtGyNu70Sqlxpq6NaChREyyXI2iVV+dVDeLnYZIRWCIJy9cd4IikJ9uTGCOR2V2abxjz0vIjC9qNFVdZ4PNLn81aLK0x5Ndh6BMmmm0zH+224ZDT1lfm7FRw60Sm1yUN7B5lUVLi2MrHXtYgn6ijaaafE+jx0GBr0TSynWbnqBdmkUyypSVp5WQUzktabOZWL94SGCIlTM9TkF12SxmXkS4LVnPSGBEb5CqcJKYoXKSh19rlVKIIilZfrB7ZbWtyCRNm2mxPUjPYU9QdHeb0j2lZi16w3eLqauetSTBvqFZR8Skdp3FdG3KpTNZjlDUlJeafplIskleSZ7KuoKfXEHEfpU3aHa1bUM5kLaG2TNlpMc0l03PqMdot6hXjzOEWpWPKK4k0s2zniM+xZxFzVPBUZxkg1GVVUlOeXDFL2hRVYt6pqKyp4HDssuJPtGBQo2OnIg3j3NJhJ+r5W2oUsc8kps+Wns8iLluYjhajTYkgLxhmY+DWlBwejKuKbXFspubY3tJgqp+oKGYts3EWmzHznG/0szNhmeNfmXRO9WTP81+nC4xtsxQQluWWcShlViVbn2/hXeOz4/LoHN/TYTSXY5EZDIsy3iYMX6fWHPKXqhUwLmk1L8tiYJ6LLMlM9MmXXGKVNKAn4FeyJZprXqhN3OVqYxco2KxYF3igEaEOl9lj0C1YsLIbdKvVVpbhWc1zVdYvLF1lDe/YFmw02fcr2hgxpukUE3HeGFYYcw1Tq2/ZVEiviSnj5tbTnKoRJqmX2HHGL18i1TEw2jKUU5skpCIytW/uE2HpI6fHmhtaql7TVXcW1F6iW1ia3tgGrXTRKZJPMyGiMiMiHNOcFhq15FVxbguw8SJNU9rfK3EOmCZupCaiqXEn0m7UjfBnMExMjqevzt+0LDQXqZOg5afeIeAska2vcAsvytPTUp1oXmEWc7HKM9pnsFbe6NFOGKDx5uawKacRzivqx11PsKIxJWwdijSaWlQXUFYSr2qy27MfKHLKXJgtDJQUMwqSqM0VaSWcOlQZ1tmyVVgMLaReZVcnm3ZQo1AkzTJfcndh36Rv2Q2fFF3rnxjSZmTLV+cY9VeN7NRNYrdYkZ6lc9KzJKRp7pXDmd/07uYWXJwUGizZ5Y+X86WS1eBuk2/uZ6somc6r71/fJO1yqDIvsayuKl0kypSN0efv3qux0maJym0eSe0pNqydHM/wG6OO9GMntCHaDBewmI+RGJhpk+nc8rOyCPCY6uBY1+jVj3PWmXTwZds0dhHQY59PlieI8ymdoopxl/CM5p5m7kz21hfjExEPoZtnF6YS4++ulDKO8g+1aw0elxtL5meh7xymJ43aXx0QJqLLIt9cng/ZnqGx6xTsjWtII2pKGJZL6JvN5OKhCjAvHs/n3A3P0FPlIKhhrHDL01TxsxOYGfDyTR2p0iMb86wH7KtJo54aGyYOzdzeE0tmnsezHcrbG19iXqp13qjb3A8ZEBjsampaXe9mE9AlZi0rbm0K6pcurVGkpNIV350hoUiJGiwc7bQi4dVjUI7Ri7ScViIlDx1glQ6mFtcgkhcb3zcst5Mp5O5wH6ob19jk5s2fahoszZXW23HjGaRO422qcG/LnyrLIq6cjrIgp2hPLRBh9Sfx9w7s4pOhbg8inVQfVPPbl50qbK1dFCmNF6udLJgOXdwtGFgYYs3sdMhSV5tnmSSKLiRVaWWa2VFRbTFQWWYqY2uR7q9Z67IXGC/oj4kfa+qL12nopafLqaKaJ0qq0XNl09AebJvT6A3StmPgleCUDSuXYJqo1OHgqpSccEqXuQ7WKC3hzerarNQWKnaS3s9M3BFsj10oTl/z5UlcEavd7hJSaCEdV25lDCusIjBcFDIRzmyi1+gbKWdppVFtyWSp5eoaWd9Zb0zwjWYnZhnZoKEtExNe70qPEqLTZ9xyZuuM2iUYKxMQ1VDMzp1kIRfsiFhNnlmni6wssNEZLOSKKRkwdV+Trc+k9BDxHmEejaRT3xsVM9oTlGhKqOwtsWPoWTXgEWJoJV+h0RCN8LNctKVYly2fULibiYtkEVEm9erv5y60bjGYVx+eMicesfWbcRjiD2MxooxXahn1W1EeI2vNmi8e2ScMqs8wr6UGoSlqERDqquiQ3C5Mr89nX7aZjiFNah8cUtDNpjfXms3oIs1toV9OF6p0raXm5d6uqWFTKWmzmnTRGx0ba03PF+rnGRrgDc1SEdBn83Gekp+lrvAOMmk2pg4q5o4XUY4oYdvy7dPrj2Jxj2StTujK90/mUCJx3eapTc8Z21vhL+P18EubDPfmcsuxmxvl5iHTVBdYz6KejeFupVBPbZjSIl7xK5AlXk/mll+Z492zc6ka4F1dpNkVrS8uh46nUq4alZ9rr6rl7VHo0eSpWOedqw4rZVihH0+j049dI5QNUKkpVdYLS9KzCjQLLVPbH/EibuMlZynRK46jcbJwcl2t32tvnwsXSrIgoBmxz1Od0xjtS+k22qrbI6vlY83kLhsZU59YahMOp2U2HW9H0lKRIt6ibCaW2Jha4STr6lyYSa7o0q/j4+NGWhVQJGCi1QyIUypYFt2LdFypjGK2zB/Nby5bY+Dn2I7mNFweHl/s5RDkE+vwEZoLJByxba+rWFhWZy5pFOtmc6ldGukksOJUCPPn2Fbo99Kg1e1SW6qXDPQeZOhZkyeQ6bUpEyQjD1uwbx1lS2Ic2HbwyliWsVYtTmQK88oj8KUtK5MRKhrHR6+QKwxXozVW6pASGucz7AygUNb0DlX4KWDPYc1YJicpH43fF++KHaqejVvgoi+YzR9mXR+bcZQwUd3yHPHsjewQW091z9+z0ygb3eAcJhPbb9oi7lLyHFZnnCkfGdcj1ZvhV55T0BJlY6Odt2UvzOUQIApOsiapsuV0InLk6d3XIxAd1BHfbVGu1uBzbqrra6US8x9i2uHs6qHvkqCTM09RY44pI9uq8GTmbh4gmLMlzmjs7N8alN1YE9LOTxczVvKY4CFqmzOn75BbJdjwaSBdLTPKj9QSj15iYlocW+YRp0xmLyD2CxJsqhwXkafkoN4o47VK1tZyWpQnbmnQ5RHXm6IR0y4VzaXd8Ohl74xzLV1qz1RToSZpEJrunCxP5coxFluIdKeTGNXVouV0Eo1e8vFbm3ALLs/w2mRwEikaoFvVZ11WiFneElsgn5FOn63zaFOsmnIpliki31PLK2wN7ZFqDqyW9KMznV9iGuHfEJFYETAj6aYKaBvm1hNOGlxxnXFR1JRZTNKQnB+hN5kVc5pM5BzgDGvY7KlOiiyf8SDK4ZSe8aRw1ZeWCevnTm6q5u8MYSKUSNsuXlzmSPDjmiVRyxhXNffVm1kcz52oMh6JrFrkLqWPqCFebNZVSOIZrgoQ1ZBdI+Htm57Wc+9Ql9JUys7cjFmuNJ6fYCquWfD0ZAvzsKBU78xeIRXOIbRTmJ2gFVIen86l3s4kF3SH8dXgUpdspvKxXucqDiofJBuO8Z2oLnSviaKn85Sj4Zcydndj0csto48QnGibVfsiTV4obh0r6mPQ5mIOZiiajerQ0KGQFWoQmE/xX+Ij77CvJanh9U4STJ/dDRfoGm1ecbajsHeVnUqYjqeMsZxO0qMW3dHHkojmKKPvoyFolhD53SAQz16pD+NwY6MXSxRJE++m2xrprBDybC5WCtDoYc5YmJpWbR7wRlAP4DLqS54YVF1gzfXZ+KmQmNefZDGpz1zrD4xfWhhoMDNkHJojCZzwzYnOVCSqsqyVE2mTY15W7WYODDFWF14hqq5M2sjx7qwe2LMiOV0S2loMc2cGJvHZM9iqEFqsaDaLnNwOTtvgYOpaSylyiw+XmJtgXlKVrPHntCHZWCUeYBao6Ke2Yq6YlpmrRRPqKNOtS9ykLezxjEzKTNtap82j9q8V6RKvJpn0FuxmLEoRr1it0GYpE1djJR7JmmrW0SV59doYIqTvT+UKjEwzdSpcKWEckwzHpHCVyq2Rl5+oZuLcj7Pli/JwCl6imeSVrI9VIKxS6ElQMOqNngtSydUPG3hvbNPm5tTsp18wcYzpb2CbNQriF8/pk+WwZLFLWueZ6hVmMpX04u3hF2nw0FWnTjFg4NYzHYsMEM+tHRfeiWmz6+VdVeE32I5Q75pzIyU3cuwLbbSrU23nrNFNjxamVJJqpFpwb+3hSsomUxzZz8715HWOYNbWikqMbyVTnnQ4q1eVWPhNDE5NUpJb51ZoU00duA/Zcy2mYSGzXphiL7SYV5fgGFIxW80NbW1n45foaCmZTnKmlFLsKLCRKk7qy2IfjM/RXLPd1HSkqJpfDaajyKFcHFqz6o2PZvBjEmDrVmuum9uJNxDcndqsUd5VMiByNhng+GUh7QqqRe5TXZdQ0GUyYZZcqeETEqERn+MtTBdfEagxpGrp0qHSbUur7i/cKS2qIXRrrWxuoU6XmNszXpgyq9QrKapULCWU7BHMm6v0bnIulm/QHeGU0Rw4Mcum8B4yh2oKcGBo7whj71oZTBEW8CjNGXOjao1aZatkcRCU8g9tUA0bY9Htot0taaGRT5DhVlYoqQ/fq2GNF6Ldn+rt2aWiaiJmrVQSLh+qImqQYFKfVBAUam7Y7rOsmGOiMZnto3QzpBMxXCKaE5KTz/V5K9inaHDsEuauFaHlz29VmmHvEu6UKy6omzX0YViyysvk6CpOmFnOofBlnmWzD7IMM89yJfcRqPFmJtAYqynREE4lZo9W5TFVkyGVKFUTtU0eEM2v1PTloxqLqyOuWqITm+mKqekbcKKQt68L3e6u8HMtpaCKbt9c4RhKYE2NT03b5C+l8kuiKPFN8RMP4JBtlx5vbiomlp9dr4rY6SGj4qXJpdMH9ClVUjChC1AWN5XhSuCpo9DpHq3JymSY5d1k5O5rVe5lbevOlCxXYGaZ1M8NLmZU54nK7F8aGemaxi8qSdNSaMzoIi9q3JyIh1zes46LT68YJe9Npe4x1NytkhHcG8+X3Cwi1COnch+ZV87gM7hUIBhLjQjkWGvFDmdgmgnnKdaSZNj1oZsciKwxTCNUdhHMFulopmxdbm8Pb9JxFTPhXG7a5K+QdynUoxLZVSTjGRWYnOGhlxZYLlCSMJbepK6KpRqQq87oUefWpoyr1l1x4gjoCy+pV+wcFlbLj9aUKdna4qZTYRWzdyXQGVBbIQ3w6xOPWsxu16/o5yRpTVLmm+0PbRtXGBLVX/FVr3PjZlBWXu50pDKLzJbd2lR1b+MWS6nrGVtWOhmmU0u2W12nml6Rac8O6YljDMrnn1WwLhTpsQtTi1Np5+uVcigYbMmP6+3m67jhXKQOj05U8VWYWMxZi2tmipijp/HhspGlo04aUOgZFk9ZKJHsj2ecLyampKkQrFhiW1JSpGW3GeBPTmhkDu0WrCxQkm6lGOSp1TGOnhvQEuXZdI/w3RN0akomIqkas21P6yvfnJeScudo2mwYTV6fUCGclefQlVWdzogxKG7MZCgkEbh24vMuz4xf2vIOI8nf7tQszlyO0BBrixWsKVmjdSmboxOyKxFl7m8jpmbbtIlKz5Zu6qdsz9OrG3HqaS9P8xCVZ54fXWFb4uwn3LOVLiTObOymUPTx9O7m7+svBmLcLULmT5zj2GjwbzEsrRBJV7FoIFCzsKzLlVibiE7SaSuvc2ocEBXymvVxkpJJ6lsUzNNrshRU3/XVnhY0x+ZTqeedFPJhaSTem03skuBvqXJKCjLcU13ujuqFm6eapNlpXdLmsF2z6eqRWKHd3GSys9ld6Vw1UBFdYxSmW+CbXZFsTlUmUBKjZU4jlPTUGlK23SxXmt5WLlHjoa5PMNfozRApJeSLKBHyXmg3oBvYHqKbn3BgLBfL0m2rWzIZpGFi5pERn1Y2ePdOjyUx3daquG7XTG1bcxVJzEppY6CfMjaQGxQP7XOO4lXbK6Gk8ilYVViS+LIhygttLPVkGEuwGLBiX/BrqE+mEShPmXHtJSuZz48qkTDccxDeItH6J/FTNmcObJvj7mfzKvIf0FXfbHDeVCah2PHw8JpLZNaoEGPVLvQWkM4yExCeJKgfzq+bpeYX0+Lomake1Cgu5zCuMpjVi9nWYZ/tT0sNlQulGpEn0px34KYTJ+PLnFSgjOQUchIs0dnsYFIUrm6LV5zUWk4bJmDQHebWmNWLppbXNupdIk7Wk63Zoyukjsjt2kygIl923zqSkN/VaangFFUpkQmZpVZzkE8aHVfwoB7udNnfp/SQKdK0bqpoE2PsJxZsaHIe6o+yWdJq21SPkEyzmZtXjaXKW+9OHhoRUNhkHqBgbF1ubqBqlc2kIBWLnK5mRmXb22YVqAlSK3Cp4aCc6xjQIyZkV7Cxjh7WIOOZL9qMrrHz2NTg7i+1rCDxoc1p7uKf3xnx1+QcLkwzExbLrV0QXOEWZiYtqRJsbGxgianuUA1gkdxQ8qYtYtO2ddAaHRxOC22kZLfu4C+H8atkHWVPF2mWUGri8lyWGLviZVlhXBQfKJ0tCykh0TForeQdEi4Yklyq3JVPEtzr6tsQIZgOldikkSb0mw0Ur69I5E9Z551lpszoGqLRltq4W2HjsazOCt0mUPKuGmNrEiGnmlnmIBFV6zJgqZFaB2dysyiQDlRvkZAqnvbPSfMPpZCmIpZrFujMW/DwTaciR9GgDi3MbFgYzbFuUGW11K/PF6KOsYwUqaKKE6y1GpVZE5slLhVPrpJqJqbisyDc1I022mCXHFNqniGPLArsoLTPUu7cz2eO4+WSb+BtKq2sWpKTbctuc/KiFvKnMCTn0mmvDaiwoDDXH6/b3J0ioQtQFjWc3WCP1+aTDmJ1V/YlMPqP2O7oT3LkTw+jZ7Jn1Znx1hkxKDUd0t44IeKzlR4cTAxoJFDqUeVdjBRoahtlzWKtF6TaClQcluraZZjaGu4MH6lP0szPLvNTXaIyUBkQmJCnhWGHoQsv51oTpdwkpGJfJjBqrA3wr1SdMOKt42Ck5ySK6u+eT2buIA1Z7NAhJNet0eIcFhRoFm8vr5OuLRvcYa+eKGQwS+zrqU/z2udwLPFlIRrs01TXMDCylmbVD7FO5CBXJCm1nzUNa/JUiu+yMBnN3+Xd2Zwoa08RKKwqWplp4k/1kU5WMLAQHZcvVmctjm+e9ZKspRASTCSpGeqidF5OZBCbSlTX9AxkXNVdHGfq594fHGJiXGjQ83JOWDTM4KpnZ17gIlef8i4lXhorXNDm0DgZWZXY0+OapqOYLdryIaP0MU8iEy1Rctdo1ZtQrfErmbTX7uEmo5hXzhxXVC05VKTsddVQztZuMU4YcCWmLFeSFiWlHFVtJCmkF8hwEipoKo7O6xErkWxXr02Y0jP0yufKiSKQzJtjjprMqqlc1Jbb5go0zNQozTZRkHNlqk0IpZFkKdYNnd4PErBYMp/zYZ4zFaFnNRNgcl5R16ybnHUzYg/TDNAVJExfVN8gJWpLIUiy09bW6mpmLise7mqp7dhb2+Fiax3zXC8Zn5dToJr7JRxTT2tQGVgiqN6LNO2aaKcSdGnqsapkcRoeIBTuU1DOzg8dcaexqaykU96PY7C25tQlYpkvX26lmpvW3DCeJQwumhBaZpUW6mluldmyZlHcX1WfiqNVY+uoJ5ptlejuo6zKJowzr+yQEs6sseXb6Q0VUh7RLJvqSagdZ1QriaNbtGVRWlPa35iu8jBtptXLaFOrG2DdoonKjq6vTFe08BIrVd9isB1NTtmO5THHTiuGbBWRIFhPIGfnW6SsMFSbzc+kZjcYipmp29sU5lIWam0SYeKWYhPjH1zOl9Oe841USuiL0FcTH6kLmIiaJVIY9RntoxWvFqqRcyrX5bTY7SFyqpNTb5zVX7GlsorqVVeQdA6rGBGSZybbj9wxYfJotlyR94+SM+8JjYwzU9hp9DHzTmAY1BhcsC6fyxgnFYZXT9WSq6CSDCFuKqnei9yS5mtOcdCe0dhZsV3y2h/cE6uq7tIqVujXCozXrRtgZs6fHiWjbSajK1NJ8Nws5JwwqhkM7CSxYm2woCdhiLSesbLTzgznNBtpnigypGyPFu/mjNXk4p5SK6200OHNLEmTbPAlUCPlr+roNQufjiNOLpCwD7DUo1cp4xFf1GqaWa1zzGnoSiDbiJWhbCmLjK2MoDBtzpladDAJ16VdC9cyixeYo6fVXWbkYQ5aURP5uibjXFsuLdNtkjPQrh3vyescJh/tmrPzU6FezWEa5+uRp+Lh3Z6Tn9O082sUNdbhnu1RZxfhb6xVZhvpG+VuKGttKiOaNiAkjGtRN6Ig7ByWLIguaSoay5lLL1ebSq3mcZEISqppIo6NZSlbHBLmIE8ZEBJo2+JSD1RlpigK4i7olk7z9dJTrxDmZRktoG3bXDCY5KRTSBfiD0oNjXglTCHNmZvWXzKO6GVVlg5u5dSvhucVkG4QTmg4zgvq6AxMGbbR+c1mlBPVGyhkHW7tnxcyXm3n42DcWVPmr6hlrnVUFKB2HuTukVRSVLAm52uerCKNGuBRmiwpztmekN1J4PTqMZPhlmUS4lgbqVmOYJIVLiCmXiVcs8tWbNdszbDOEo/fTKeSayCcDheZ8LDdGzinoZvWKtmw6XPcRqYdI21abugpFbRVNK6SC97J3IvqWk5PttSqrJPSN59ao+U0n5owEJYwH1PabbJPs0ixbzEoEhBqFvDtqw5RMWcN3B+rzyYhVtKWj1QX8qUxHRXgIx+iIjMO2t1sDmMOWxHvBvINM1qZizQ13/EL6paWZ+aQUNIzjuXJF1AZ8lfMLuumCs/3T3KtD1Ti27El2VhZ6hwkVIfJIjL0G2fiE6QWNe9x6KiPUxznWfNwLErahtk0XJSnVJHuXbDoZaSV2FqhWWnQ2A8Z3x/lWZPZD1BTs8wWyydVLBdl0Q4SXo+Poa1LbCOtchYWGpcO66NhMIuqdaZOT6UnEs1oqUnsmirZmJsqIJ0gGlcxnosQpRDQYtvarx2FHJ7kj9lleSaVLJEM0S3HKjRrsBT3D+Bh8LGuVNQU42BOI2/dWw/xDugb5pbZXq9NVGOQ2VqjK53sl01JMd2SNjCN3zExr8oupXUjslSiqhdc4fGOMndWFJhslGZpYCsOZ+nGqeZPTlr3H3D12o1d3BPepNRmLWjfDl8foWSbqhgJLeITWy6kFOBlGKS0UGje29/2cNmW7Mwqas0w1dXSI3SOneFwnaMjac+SWNqrb9zrIzNeqoxls2eelxzQteMx4qLvClPNlKi00eHPoLSl58kwUuIzCsuuLC4tFsqXoicX6Ce2c2kWzYzuLU5kK5JHa1OhNtEmHSnqzlVupKjRle83Fc+bFS1Z0WScUC1LZ1IPKpDT72ROnxEdirMQ2mayWiMM0WehpGBjGCTKpG7Ps8m0HVIL8RpoKZmJISWUpKtv2GDaKFWsD6Qpj15u7hvr03Lw1mXVGZFq2J/yJ/Av1QcsZspuKSml8eRZpJNa2uZMDqXijEuuWfdfnmlpEM9mr2hwLeiaY5+L0LZNyTIvLhlR82bc0BuupdvnyqKUjGDS5xurWAqotPkyK1cqWpJPGiNuZq9SVKktc3ELsPEb4JtPDpRZYpGd5lIVr+/zjkhL7PYb6NHlp6VNypRNM5jtHdwfkeeOHgiX42dMoQ+Od6MgmxyZ9lL2qbQR8opu4K+ponNSGFGOtmPmdGqQnlYk8JJn2OZoq/JR1F72lHKmrej4o1iuM9Mq4iVOsNmeEl9Y2vLKtB4ZriTSFhnTqd9NNEpxK6/m8nPzF5XXzRQWmAmsVFCUo+IbNB5ozKj03BwrSySnNqtPEhpepopbW2DqIJ5wjFJjqKQRVKNwHx+ODyQUFGcoU2woVc+TV1Zkj1HnU+gmM8rN8xdQs7Hf4t2J3JDhXyrwCmjdyQxtDmtcsBNM0/DbyC0ksg1fjZUP4iBXjO1YszKKJA1zLBv1CFKt42ZKWeumXQzvWG4czG8SIqSRzx7k66yk33DXhO3r6UxmdCZq1BiWJueJaWpWl+JeWZKzryAq1UusMBloKh7VCyXN3TRVpGrtbJYjWF1vbDERnw0Pk9arVSO1GBqmsJbiWS4vtbfLdEbQih7Z0R0ScBUm65ysNhzZlWRS71PJ6+3ca9VabxRPC3MenHEtol7lZV1i35+Q7uFdXV2eqmxfNpsw5V7ZoI91pOhbDl5mJ+itj7NOTxE1V/doHhTas5sTSWmmUhbell4fIC2WjGUkbzVrcVDQm1dNTeKwtpEnKSqwmyclrxvn3U+iklOvLMzXGPWdYqx1uQ5v3FFTSuwcsBAQHtlo3x/e1seZUnVMq7UOI92jp1JwKRBpKMjqM5D5De8NXQ1ZqFaKc2jPHeqtHFOeMuQ4kyTXHjRhSSvibiakmdKeipyuWywLGF0W6LEsG6USH2iRN6EnK1AcV+4cqHeTUfVW2o1rGVAv9NXKazZ318/XlRpbHI6rUOj1pTPHWmvyWRTRHSjpGRiWKZtkDLGj64tZsiYloIyhqSXuZZKRd9GXkpkypbJx5a1uhymyZdUZpFcajlg0Ypgzd69OzyWidvJMabZOa1fVjXTcrY+WDTHkklBvUS+wqKuiVhnSFJefNk5yHSogZ6nnm/QdmynZF/PLkrEQEo4OJdMm6xZn7g6saBHvlC8cnV/uDNguSJcPDtYLDEwziTHcq2CbT5lQ1+1l5NLXbe9X4avbTedXXjCOLWrlSCBG83GmjJjyVBhfHrZ3FBBx1aqNEBMLZw9XYvXVMmpZI/LbViDIJ5IpzpMpmDFRaR/ur2qc3U3qXdbYnF6ddJsyY94ppmdJo2Vn5xGusRqxWwvwjo/f8mFlC+zubpGYje6NZO1ilo+U4RghcswcVYkgN5XQkzEVKMjrFaceVhj1VhqeVygXilMVb9WYJzBR09B1cxkiHaYWEuULTI3zjAzaixWmN3cN84liSm2IMOGSn5hYyzLiqJoRIg2lcVgwj47SsKIjzOsoazkbT3KPSinwLQiuJWqcjuQbcfQoltxlIxWVnc8iEdPXtTIwXClnk9cs6pQfhA8uyfAubRWW78zSWW3xJpxOmdur5eKQE0+mDpkKWzPlEw6h3lFJ1Q+wKhDVTbMy0mQ43hyxL1dTbOLdElyPqSvbIIySVxNxctmOaVvqXS9Kl2sjTliaFiUNzS9tD94eDqccUyDdkq8rbM6Z4rOV9Nw1kpjNHBv0JGKjlFicnZeNoTOYTLdho3OhI0pJU3FUNV+jT5lYma9Xn86x2tvppKWx9xqV3TAZh+Au1tSr9pUijzATERNantYn2thXz6LPti1amrOH76VwbVt2IDIjyPIixx8qGt6RXNCX6kwVMyQVoc+nlign21kRWJ+fUeXnKl9H4Wup4SuZYhfwKmtyKyMMmO0VY0redOqWboxs7AxWM1tTpSQfNJpU1mhfl3IP8jEMr1iz5owyEp/N1oytHSRrki6fTZCblpffMQnSVettU67WKmlTo92hmo3p61dsoNSdZdKZ0dDRcVVhKM5eHSdSG/EpU6Xeythcy7EsByUK8muxqmPm36ql4pvYLVLPmR9ppIiPng+hYLPvLdlMkjXozGjrFrGUEOEUEyXJIW4QohkTbdgcmLTccLGcLFYOziqnnNCRZ0nmpzL5Dg1usafuC9bpqFCnB+czpa2umG/lk94iE/VbjyRgFmmjbxqlCB6HnSaUIRhP5u9tqnEUsvaXFBWSzHFwleHulpgiEChmJVsRDSTcjM5X6OPzpa+QYyTUlg3JpLKi3icgLY1j6ZlK4M6wLFuo7plrjBGdKlblXApQG+4K6rP1dppmHM8mTbHRUJuRpMziTS/XkhwbHuLknWZtr66tcBesdzVcHVO4My5wr5p0UeCY8vRPDxLua5FVqmmtc+JzSU4NjF/QKuROoVwd9qSKrnQhT7OQVDAx9pEsFcoZkLK06CKdbhOwEmYhVa1WK+0ps4/ULOqS7pVUFWdtqvTap5aslBQp7PNtJhwNWOfWVpBw7R7x5dhiZqyWJCYi3edhJuBo2/Gl2yhebakrr85vHipq43KN8AscDmTqr0qKk8qoIhyOSZ0x4O5LSXJj07MXzeCeYtqK+KEQL89uXpMe0dsgY5mUVekrnNk2a4zV5U4ScSYQIOFRcJdk4JmpHjXPZHOvpOHqIvESFGsQuGYTY2wM4eFJjVK0oGTRNU5LmO4ydBQUtiiRTBgO7CiZ1XMlZg5jFGkdZ1MN56OMs1NTVQzSs81quO6lZFxMj3Re2OM0oaKdW9wVXXMzbxvQlXgY1Sq1juOu3m1p8TAcnbFw7y9M2JbnGmUMZNBjCk0wrQ1orpJWZNwT1J10qyRJb+dKmG6Mb04atWnc2xem7m8JkvHbHvCK4eI07edfMQq0Gt7QaEgsJ22pM07Z26yob1EYIaDObAjeJG7UGqbrp06wsM3sHlFKTiqoGtblGG2pItLLMFKX6aLWIqIs2p0jnqhwYONp7Q2erSVSlGJUKewjWIrw8NFY601oc2+anZCoLrWnW1IWzxNzoDBi7ShrEsrMsi4XzR0XFRBW6cjhMdhMD/abDB6VYNCquFGRZKiL6mZqkBRicAxXG/H1DZgMoovlzd4uhtLdSKQiJCBgUuepIRxNSaraXd0eGXoTT12XbdgP7bKOT2wnJ5DjqN2ZFqjy7E/THC6W1hHf1Ezw2hvvsU3d30sNb+jG0BxosiaTN9kUrujoJC4Mj2ALM5luj1lqJVTXmawc6+1TU+ytMlKkUm6gmhjMcSbuqKzklTGaUdyiqM91785XIBNZ8bQhJCZirErpifKsLC3wnxAoi42v3hyk750vJGWamNxm7qShLOYOqFdsoSFlrJjNWTLNpTDRMB5R8pNvjeWppGgZWstrZyvUy+LNXyeWlJ+sZ1AQ3DpU2bFkLGKfi3LW6d7TZ1br7O/Ya1ufLNrv1rOPa7MVXpeU8NUZqy24Txibl6tqKW/t7CrbYvFw8eMqFl1pdp01lsylFmNnS1J17o4x5+0TWiWTqFmf4Gxl8uYiq43RnuBvr9jVCamdFlXYJCpR7vSU7ZqJavPRDTBI82zcyqXqJ5+OVWVZHRFaj+IaV1wsUKvLsc/X5tyt3fKYEdmfDvQzTcqwGUso240VqGeU8ilbsW0lrKeozxath55np0weWmVg2kTh3xqyJuYYMFKmTZOjXR4n2p7psPNxKtNcCqElXufL8ubfOTFvFiymyybXKluiyeKPsIxfL1tSjxXMaWuiZ5KQzBdUqGvaWN0xG67btBTm3F8umq2fNJNrKzFmbpxtr1rja3Akzxnn1WYcCeeqbJoW1tJYHZGebd32sFesoQfu2TAXETRdt68lJBCbjAjdYiMaDlspmMy17O8IcOYbaCKTMJSdYNgKUdssKpMyDZu0jq+ONBMXFCe0obV0H2+wlXIwEq2W6nJ31e8UVVp0VzDU6Mnn4lwjLhzsX+GcU3UrE63SEHhdmysb39ud6NTno64gTuAqkEhgcrEsY3CsWt8V3dTskjBmlJ1McvcaDovXDNZv0WNV75SQyNhL6NLdTKVb7WYSEU6nsCHcbqqfdRXP8ph4dxMWcC0ZY/EqXxOez2yllKMOks/pKTJZDKubSTGikl9bneud8taxNNGTYegTpA0enO0ZnqtJ4JpWH+ET1uXSx6Qei9hJjkvd2eHcV6+eL94Q7yyxjOrnTrTNJlTs5CpUjPBYj98pYKNfLaRSm+NWHqkajBMNL9+n2Y1U7hapsGDnpUpI06Cd8VeZX6Fg7I7umk7f6Jxq44wZ3lwsX2cslG7N3xsrLd7s56fbsh6vaQ+xW5Yssyhh4wdWWO6xctDb5yMrlWIuHzEwCkhk1BhzVvQcSmKaCdmrSZWOlVLdEF8QUNLMa/MNbGQxa9y3lxdYpuWJhclu6ZItS3KvMxZXaGFK9acnplLRUuMf8xqYsC9kpCFJ0o2gkmCf4LEdzeVm4XGNYFMTSxBYZK6wrzGYyTJZUB8XDG/0oG7V5aWdER3kGd0XGNUQUZ6ZJkapjJMx2J0UWunSNqFmqCiSkncfJp4nrJ2JlGBg2s2kjmicUaCe826b2uYJbDLJT1reUYwe7ZjWMoqR4V5SHFsRsdzNTtOfYo0UIq1cyVuvswqs0pBIJQ0Nmm5b71OUlpIdVU2M9rEyME7bGFOTTuSf56KH3aMcxmvLip3xD2vQorETqZxobklOHtEJ77EcJNggFJiwZB2J6Ggu8CDpYEYYK03yLfWbytjQTZum1tPS0SrRmK+f0acRJ6CyVpDQ3p8zigyWZKxSo/HfH6Bw3ib0TJib0BnMYRAiNdmb6iLU0HRcKs5W2tEnJvAcUWrlsYtLac5rmCMUFDWbHrEozkgorM+JZWoqn2HYkC2KsTTaIlvklVXb4iLkohRRis8rYl2PnvGu7zOg5ZEKJzPgNFxUa1SY1acisecVUIulaHZZEU+jWSsdtNYyXGzw09s4WHCRJsos7GgnUhItmR/yVFbKj/OnlbdYXGTuHSlrpAtQ6Axu52+liPCIz2NSDrJjmDFm5jEeIuyKGutwryelHhfoIZkcmZKr32vscJ5KZ+MdTFCOVHhPEumMWF4VFHCvn4jdFwsyLR7N6uaq2V+ddyuxLZdNIeZwn28eIRJKK1y2F6XPzi+2M23NEuNZmeXU4RBWVV0nL9FkLqNWGswL55WlITIQWGSct+SpECQw4d6YbhUOZ17c2Q4lEN3a2GrmSvFo3fLk0PKtmiXjqE2Ga5Sw6HKVMKXV6V6fLJ/ohmLIYNZtFGufE+bf7FTUEyrlMRTLze3wFpxOol6H8Rss8RpZEHWapSqxDZUfkVNjK2encC9qViXhI42xa2Pcb5BHVWvvbs0oHZ9PGLJxzesLtZGNt5KZYKucSymTJm3OHKvPjO1MrnKnmlFsKyiIFWbn4p5ccB3nJ2nuEyWsMy0wlbAet9MSkq7aoNYu1dLJqyLqsx0uKCWmIeTyp08PjJ6dZyMrozTTS7YajG9UIVyVINDgKRgQ6F2kXGVYV5jPINXoDK3OGxKtpIblTl+OLddqnixvaZMtUNlZH9NyVGnUcdUXoLPNjdWnjVFtIO4eNtxvT6/Qlh/vFxTHZZtbsqGT79LS0vYV5/OP61/rdpzTe08kDsxutZWgm1ifChfilGZk4CnzllQrcN2fi8kky9eg5RMvKQ9iYGqe3tSVE1cW3Q9yi08UrZTspbBlF9qSpoxVG15ymnQQIlqe7a2k409TMxjs6vgtk15iGmQwBGrWZOtSMqHSWtmqUaJiXE7TLM8jaE6fabMNra3eVGdiz035GPHUUDOrJ1LrBWckCpakF9uXXFNP1+xXmZBS7cfw5qFuSc6lVamfJqVjG+DpTW8hnyOprWoxjeIjThrPFivvqi4ni0+s8eof2ibZjdgur02bq+IN6NLRKslhKGLYCaifadJKsBcSnpP3WpfhG8ugIaygEpjyJGxQrq4d5mlTSV9h3hWj0m11FI6kmtLc4vIsZZTQpKPirVLpy2QSWKbetLNNzG3gdVRXUzBTjpMtb5J0rWuf8d7M23JzEunT21qjoFYzzW9vjeVrIGRkM9BlnVtjn94znMbPreZY5Mosrter4xTm3mTYaFfOZllt4ZJWFGsV87RwE7hdzMtm02RN7RdZsGZi7R5tFFRYUk6zW9yuFRXcVTaJ6WgbzK0RpJBhKGgRUmbaY90ychXwnBdusSHvZ5QMaS3VWjAok7CQGpVy5BiG6hphm2gcqLYdUF0bjVOskzDdtNVM7WvPzfEpS7UtIpFP6mKsa+egoWLJH+RUZ6AT6o/MF5BWb9KXb17Rk28S4eQj4Y2b8OQ0UAvlE5KvV1oaX9JHFG+aamNoDNwmW51mmpdVFOLWzLHTKRjsddydUx3kr9ThoubrmzYQbhOdjdLk0xGc4F9U9IcsprPK4OP3XdpwmVptjArVohjTCzNWH1ZnFlrutpdlaBdJavRj7ZmabcsenukqU1tfDeQZIeTey9od7WjgIe8qWq0m8vAcXCcWdVspnXWe8HFVaM7lGNCQ8g0omV/wc/JP58y3YZbMDvLxZDL5GdMs1I6ZcCmSVI8i8+PK6dOtNJvbXdmhJi4NkIrJGN9vry7GaqnqVloyLOSsa9fWT2knZdas6euvWR0qjlGY8Z3MU6vZGmMrZhTnI1Fy9qrc80djLKyXyzfNkWlyIWxUTiDp3E3Kjl5VsKZU2wzLELDZF+KNHJqLb17fy22H7gjpcJBl2FcVbGTd05iRbWExndZgK2WoLOZPtt8mUE3tzG1yljLz6a7SLCiOnhaLpaQUKVP0ys2Q8jbOGxDXueCzYxWi8WoUHI23WaYoSzCmV+sS6xeaF1rw4Sib5K5WCTEK5/AONmmMoVawp+6kbg9ZpMmem0vP6C9wKu9Sp6ii4PirFVClV9lsQ+xPtmf2Fhbp2IxSsGcXMuyKZSVX4xX2dK3SkuicUcxpEuHyW4WxG0rtMSCMX8wM8m9br6DyjzNpEE72IO5W4vcV9KziYtzPNwy0NqUjznGXnClYK5YqL68iTmhwJF4QphQTHCWl5y1paZ/bkGZxylDNtGPVWGsPViitYZ11jeWh5M9XMB0VkfKs1GhM6mbglGdii/KpHIky5aEOYqUJL/NsNM4Orakzj62z0WwJiREsLqEYZJgREbjSqFlw0KDTImya1cbgVCfyG2TLi002cKhRJWoP2rEXzlRvrkVsaHHZpusRsJ1fFSekUp8u242nn96QZZCWDxFYr9NhzmOs6dvjLa+qGxHvK6ltGssPcq8Oti0OLR8ib6OqZWZtcRjSEagYkBLU0q5XLF0U7ayfEGhuadOh3xnYD5cQnFsnY5wx7WGqzRWybVes0c0M2jKZX+NVIZdubmbuq3GvmB3Z2Qpo0aPtk2yMqqQtrp9ZWKtLTmpqZmwtTGcYdtc1UpZOtiAob59L8VQuVaVRYbFkkGPvy2VaaafrhyGSGS7JkMrJ6hoxEBVNE/GuZHNv2M6SqSCQFxC4zs5SMScjEiHo3lWbURQQUdZkbrKyXFVgLg0SEnOkTuZsLe8Z0R8g8OegG6CypseNWy6vrBTrJOmGz19lzbYdXtAZIezTZ2lYmqhiF+hbn5SPEC2emfWgDyRgM95ppe1tIFPlWBjtXObs1KFvcFggj+cZ4Q+k3V7fLTNSGfAsUlrd0GTlVuQ2ZAzkl9BjoFsLYM83cViRWBQZJtXZ3TEbL2YmoxJRpvQr17Iz8KXbt9lYqdvZ1uvtJnDgUd7i6UjmaqUVIM5cNPBmXtDwrptONl0Tk1liyuJUqRBurFUWSiNcqObhGm1SGyRvY6vl3DXXceyQ5e3oG7Hl5Brmcw8sLmkc2NjU2NPWJNFaH/QeGc/PXPFnn1btWxOh3tznxvPLSaxdUWTg0OhaUVhTVPeY82ixkcktmZDVG9EzEGxqsnXM9JnqlhyvnUs0094r0hem1k2Yr1my5SEXG1orLind5i3SlZhQVSulVB3TMA6as+l32mOpSJaK3TAnWsrht6JU53VfLvTdaNHUGqie1VgJjqCeIRN1lEwdXCMtJFT1EAnZKbIxHg+w5vEuHN8ncFtq3ptvTezlamoTYtEwqKXNnFTMXyram19eLQ+tkORM4SZQE08kTBDXICBXFYoqM5apY01u6yff0WGrjRTw9RxoZrXh6SectNWuK2NbZhpiK6aPb58WH2zoplfQaYwYpkjm5Y2d1mTqWTFqs1PJahUgKSsnkfHSlQpmzq6s3jEmTJbUydwjHGRma5ypSsylbFCs2bcaS2nk3q6jIqluIN3ZUiUZNWWtjwyjMSUXHG0HZaWMy2WTJJcUJOYKix9fbWOiiY0qsK1Rc+92V9VuC3BN7k8cF1seFtqkdFAspMxnCJ8hC28WUfnuy1qiK2IMDxRkaBpIRu9sSykPV6Ec9tCdkRLOEA+jWUxSbtOuIa1NVdUY6SsY6gzXsGSpLhkrqC9Y6J+dXGpZkOJuoaCgzU+LCVFgtC0qnC+JmOgV2BLPGR+LZKbuX40xM9zZn9LU1mhNWK6hITOo8ChusGKLDidMMq5aM5ClNJRpj9kPrW5fl6VmMKvH6JYq0dgnWaaszY7WWRRX0+zo8tOmDSWqVE9c2qMMU+OudqLrshT0aM8nohmo3hNN3ecmy0zMzXZeLtvT6/EObFTlnxEpKVtP5XYW1mGUme0vWaBtntq0SxIbW2gzsvRW2a+v1bQW1jGJ3ZHtdOutF04ZcxcYqZftJycTbJsqi6kO2VHbq24NLUZdcMsP7hXwlqvkGPOdYh+uTRQnI2Mnl1ckN4+N4dyTHkj0Cy4p3K+YXCKsX19yLs4k8DKgDxsVleSU5dSYrYwoUuTP3bAPjFDKDMtd055u0V0TkBnmoxEl6l2qV1ebM63wofDrcVX5GhkW3FKOtVqX2i5xzNrNW3JbMvMnC9/ZjKrkH5OvIqWm6YqTIyerd1qv2Y6klOlsdF6hkQzkqB9LZNSN5iDuLcwTWGRO4JAkUCHp4yfPYCXlcqhLJJUWSk+iMioL8XOdGKxMjxpXEBDoH3Dm42WaMa3d1ZVbzHDkbhSx3qerl445XJ6ZaObpWhXOWirYoiRdruPcHQriIx9NkqmYdJuk6mMhrdwjZJJxs16RW6lXTU5hZ8wlFtVWgqXe0VLvt1ujcelsakdja9bnpdhpnXMw4A/zSh8rk/SjkrTNUS7OEG1SDxkUr1Jk0O4RIKWSsicZYxdSmbKor13mE6J2GjTd0k8kr+UpbhBJpOcKIdme4eelpeaxGZ9yZ9wnXfgOjJKWnuVcKWpp6lzTU3h4ji/e0GOgpBHRIpKSyeSJbSQXmpsWsMqy9BuuDVOvyxIJ3JOe3patraDi6HMLs1nyoBByp2lG8RYmGSNv605okI9SId+eVNJUoa6xsg8VoGjnmN6y6hCpmeotVg0r2hWPLh9FJGMQKEXv59Wy7ZNpSaknb6QhD+K08E4rUYlfs5z1XtUYt+UftRYWstGmriOnne32kaxhYiDlU8zgWQmq1QzXrRnZK+pUsSOXqvCjddTSFc+kSmCvDZClXiFVn/jcEFsw7BuJKBDfDdYRbt/V1M/PmZlb2kvymigJWHRzF07f2LDUs6hMY1VH6hEnLfIszOBNyywS6DCV60tn21Bnd9QgVZZdrMTb3w5uS3FvMzFbCLDYMyJYdh0enSdgY1WdbyGzmdNRcF6xLdzp39Ht4t7H7rHzTA1UtKgS5g0waC8SVdycaO8bD1Ye0VwoZlYtHNgONJUjkHZvmKpvb9Y36inHqRwp2qlJs5ExTFxxd571j2IaKtIvZHJrHe/RqKdOYnLgcWTInegba93saudIyc23GSmb6VEfU1oS4p/rnJRq6VdtlN5OdFhttRzVk6fc3p+uz1mNn6BLmCXgTRxapUtraqTv47UUb1DKKWxxl2aWDlKl2FMS5cjw4pzkkaqR1uiSLCUsrGxMmivs8JskGu+a7uAxpGmf6W5nGFuZEjDf1pQrFwyY0wyVGiFqMplyp+XqHOyqS9NfFm1kaNEqM7ZSD7Ii9B3Uke7Rlk/ylYeHWiOsbpCbohJ028vZU5VR750xHPXWFxMupCSv8OSPp9IbGO1L5nDzZqJTTl2kVSPg1OEsz2zcqRjw3w8S69X0LM9ql5TNFEqP0CkoKOfbYJsjk/udWWPwMPNy297S3Wae61AmH9bjV9SrWyTWsMjat5BoGmtcopAt7l+WmpgZE5R2I+nvmWzzii/yMqc1mhrfrShtJyzPGpImqS5UptupnVtv9uCU3+7WbaOjqCPeXSPrIp6YjjWuZVWnLd9kVwzNcrTx8O1NkSGmExxgV2INYutW6onRaCqvpOkUphMaT2wpXKJhVI1bHxLmJaQQi7HSyqCJJ2nelfGt3iwzlBDqprHQ1tSv9U9xaws2E41WK5MitpCj35SgoknzcabsJC2ELWOQW66PkmiPFDAXbB2bDtLu8MUJZZEoYWfa5s9hkxwttN8hnZMMX41iTtLrZVhxz6afZKjJJ2JY59ihkl7t6N1W0FMZjuRI7+ntrDFdWdtV2IrRIqXx2hhMadUc6B7VGK2WWXJkceFfmPCuHqyr3tWO11+PDVIkXZoOdLDaS8zjLhCyI95ZJBFvXuKpU3HiLyomBMLdUWcmDHOjixGd0h5ypGvSw0uXpgjiYY/YIdto3eAvsBxTcx5boBUuISEG7Y/ej+4nCyVn0mPanxzx1ZAgKjBgFo8klTUhr5eW6xqox9/pB1qaNRNyTJQgq5Jix5ekFePLaMjKIu1Xk1ZMUi8v1ZSV4i2Q55VhaIZto0+yjUki0qufTJ9ocQ1UE684WEzx20nYWeXf4FygXF6zlLCiVBVP0E3MXrQxKRsO6Z6TjKNtVRvhs5OnbzCQ7w/i3RSx5RMQywjs5Ru1X/kbMWlla+4j7IstIahwI5oe4hXR5yDc7PPgcVQ1aRAWrSxMdg0iDqcmECfpXN6VztCi0Weh0VaZE/GMxyRQx6sQtpY14C6OECkaGAts3VrsUVdVMw4Y5odwa8n2GxYeGVVfFJQroK3p3qOhMLKMYXJYTemkHapgWTErUdlg3HCN5VnzSxwl0guVYifNHy820R1o5+Df5AtP5LCpqChLYUwjE1dSXaHQdcseJo3VrQ2j2xImc22vJqWrEpWkEZrJEDan+tCe29uNKFMyW0+eKBqyS5wrLYdeYBgqn8Tq5x0OGuiT2exXHx0YdNDkT2xXk2y0sC8RYuviZ47YaJddMnKfDi+MICwNrN6wX+cf3C8JmlwNES/dk5STjtrxT2be4dnfdNyomp4J7jMb8C4X4+ogUKiXG5eKcdWfkN8VlfPsmE9XV+RZVRNs5mYYMaLZ41k23aiomFDg6x8i5mKYKlXRaygrDWP1VPLZLqYVW6FYtM+pnvlP0pQRnUvL6FWxqZRJKe2Uihxtjt3Ip98xlFby12ua9WSVz+1vcxxM2NJf4G/t50xMnGvOz9hxyWjvr1Bq8mTn8bHcUTCS5eArVxouWhFQUq70tZbgMxoszyWX7ohj0hCTHFvcb9ZN35Jvyh1HL69L9U7SoqtjpdQMVJju7bEblKJ69mTtHy8JTo8cUNQX39osWxd13nBWThAej68WalcTlt4OFZ6hILJdVRzK9BOymiNuoOa0jFq1Hydqol8lZxfP6emNVe6pxu3cYFagMIwtpN2cDxaxbjNtTs6O6mRgLOikIdGKHOfwMxX2GxMaVG1hUR4jUhMxEO3NI6HpNF12ZBhH8NAVb2W0EmlRcAyJWUpXn3YnNFkapuBlNZIaUVhkTnGxHY/tj4rJ1Sqn6i2vol/isy8PZR4uTLETWsrSEReM6bMyrC1QX9wr2NvVHpxVHvFua+zRopDRYvjvJ+HqMmeNXrAoJaoo56nvcu9vzbOoLsxpFa0u4uinldHopJ8c4iDXj1LiD/QLz/Oq2KxaqmesVGIoJJkgWWwo7aFwkJ2O8vpYmltxT40SqmopLB4LckyepO6ZE5CQYfaxqa+I2Zmjds+PzhgW5tCwqvHYa+3uKAmizvMNuBzPmBavDBpkyOs1IK0wkybIr+nfCS7JmrQmq3OgHMwd3mNWjqKfjNLnnigjJd2oz+jNL+7r4xAib6rkL0ac2XEgo+pq1ZObqVD3Exdp7lDbZCuu1nWpNVbKb6darl/oyqcUm3HaUBOaqS4KVUvz4CJXKp7R6+1Z7KJZpBnQWvQTqCuJKFtbcSGrLMyLTWBiscteJFzryzBd7hZPNZW0GorwZmcmXcsTY+fN2SUW8PJfGblhb9pwT8hI3par1mEWjRTUKxmdCtnqSYrK6/aQcRauLtqg6kdhWgseIJFjHJYa5A7jFVJlEt7p1Wrs4i+eYWXcZHLeYk2Mm+Vx2CrZ1PVrYBO2JCYzafJa3WXNWZ2R4h7jWtdsrF6jUbZn3/MTzuaXIJCvV5MSYCE0V0zOUOaSWmIl6TOhsxfW87JN0xjTGxKc0hdcN5YyMGEhcY7ZJjDjpM+jx2KtSIxrUJry4+vTsnGuMgzm4XAYZRMb9XGx8IrU62nfEvYNIw8QMVGWlpLbteYMFZsVGNMf505PnoyOGtqpLA+ULcwd5iIt3o/kz1rVTk9R3szzsiMY0SiVJSvt3ujd0Ovim1LS3tNO5DX3FKRaqhIpk+05kRsgMmuljB5LnSawU6QjbghqyQ3I7SRaJUrhVjGaF6WaLXBxoW5WGlojGXTgHxKm05RjHaUYpVHPb6WtnI6VGmzQaWMzmgyqGHGoVI/P0rLX4UqapuUrHY+zD9/pLbPNNJ1jM+VUu1LOpRhxI+2tLqbpXGcaa66saeiTyzUj7xjkFmhfYhxQlKRdWhhMJVpT3eemcN1mTjCbYiwqFu2nLhgUEk4xiw3prw5rWdAVTfOZW2yh69aUnSxSEDgyVCzp2B40zptjV67l5d4TzbAY5m/OWpCrq1/TZenPK3CM0O0kKHLjzp/QmRU2CiKlJZ+j2FXu0OW2GqzVn9f07p21ppt3Zy+rlRIm4xHXUCwuCyiLKYwuXakbpY+sLTMtHemKpaMk7CmanxoXUhHUVaFcSHIT8s8orpJYESmSWw5JGuRpHcxql9X4sqM2n5bf1WWiVNtpMgxbKyusSlm07ZgQDXBPnypebpBMq15dzZVyEmEi6wswGx+P0/dS4RgPFd5vEQtlKXIu5Z+sKV2vKCFaMumPWCkpEW9sFWidmVqkDlDZLFnL7wvoVFISVi6cFKcXkzQP7ipr3uBiFOwU7w9k3+hypfDiLs3wYdUVlRaY2bTe3i9TT+neLZWjraRRJJumnPWn3w/vZZVmodMz88wol5NmnFjTE90sSh9oJ/bnN1yWdWHUJR7f5aLrDowhp2RNoN90aiLsoZ4k6cvVJFgnubFZnW2pB9jzjl0Z5DKM2x4g8Ynfs3fnMVtUMjSqmEogmXUj3JLPqfAOH+iMrNqcqs5rISCknhucqqR2mKIW7SjzB3KuD5ass+YfElvmndTlSiJplmPvCnLXHtosHhULqw9iMB1iX+ZmLxTc6FzeJuCMIxisbXBdjIzp0NUnp/PNmDRlp/RsaJiK3VBn6arknKguT6Vcsp2h0hsgUaSsXifPanGz9NigY9lNJawj5+yfUJRaZi8VWpUS3mIWpyrTG5DdDPPNlNLoYdcOKklQczWan94okWTi4OcRqxnu0qzNDUzSjR2OZU7wmS4WbODnr2BfT6oxEIrHIt6oyiCfobNqz9GlL8zrpWlYtKGm4umqF09XWdNr9aZxnV4Pcq4ZLjZNHtch6JDlz41tHk/wys4RHrTV6GfUmlvm2uqtT3MI0KkPI1aKcRFUJ1ixZ1IxFJEx05bn7PUi6VDedzGsK6IQVp4sEuKmn+ENIRBw8hhOrkrQX4xLMUmITWRLdOocVVLyjGgQ3Vd0Js0jGY4mVd7sc6plYCBVZoxZUY9dLxdnS9LlSaiIYAto4tbN6ORzMkyxa6/Kko6io+WhTVfv6hUdMRrglu7KC19RZh+g45xLLOodYHngXk1Q3PJSLJNmm5JPMG6Ws9MUKlVzWfMn16J1kfANlEr1ZNMLrShgKNngH9+KI+/tjnHTUCcUoqRrHaDj7iKj0ZIf7pjUVO1kHZuNoqKYGhvZLB5qK9emUekTHFCcSWTprCSbYnVZkSVnzWXpVRqJ3CTr3MwtdaUc5JMRCmZQTyDmsmQOUR+2ze0r3R/XHpQthusQatXf+C6b7NTdo4jIFqM1KNOp0VEfFO4lYCUM5O7hEIw0IZZN6xMZ9OUfLhmNcp8ktJaR3SlnMQsFMfMw3dlhzq3yaiNi6uZQE/ITEywm4Sva0uFxVxpWVNdq8uQO4TfQMC/SJyJJ32SX4NZocZbZHZ4jqPHmYh+Y5XlRkQzJtBmkWqFl7A1hHTHuYtXwK5mxKG1joebuFViO8421Js1ZVyWWb+Feb961Z9XpcpJVzijpZpMSYaGRKu0tz7PendZ2TnPSm/IgYd4Yzt/bYtfyCl3Ls1xwrrDjc+I2j6tz6k0gMuIs42gjVMmxyF9v595X72NvlZFTleEW3pXbJk/SHGJpUM1pXTZlNZ3tSQ8p8mDxcSyyGzaeTJdk3PJZlDHycNgsYKYo16xNKHFKWShY73YVXRFt8KiwzOcl6d6wWgbmtOzxDdyxykihCeCV7XIuIXNzkfGPXRTqbek05GNpCc8cr2TkV+RezjFWFvKWpExPDJRg1MykVlurlzIkZiaHzm6QsA3Y2Cc04/XUVVbWFg0zUt5L9CM4Ec7MnqIpbOPbEZTmYeOOWPIO6E/j0GgRIC1PbqLVKG2IIuDoW+RnqqIem91ccK3sX9qmr0ze5OyuC1YVzFgRHXDn04sdXNnQEaUKSyxjYNncGXCnl92QVZAbt5mUKkmRKfGWX6FsbdqTneiqIjVLrWHS60q0ldkL6G/IcNOrkHKY3eUilrFqne41TxrlnCwOT1vRUGexVdGc406eGGZn31UT8QvSkuEMicxtTk5RHmzjrLJapWOiCGslnq1pj3JjmhZcqTLRC+1xZKZv0d5cIB6Z1aDbkzQsbPPQKsodHOUc6vPdXuDnbd9XsIjJIVvQLt+Wo09KsevaUukyicmsk60jVSVxCyniLOadHuvTk9eVUXPcz5fN7RQTZ+yMnY9f656dEo/P415aVVzz9I9hoGklDaTa7FvQ2BpQjydD3WyIsl41q1301NhrYBen8CNynosdVmapjKPaWoyxo4yX9ZnmchJWa0/TW/EYqE2tFGcb9SOaVq6Hl5ma117eWa4cWGEjXFaxLp/k7hjWLFVbT1GdKOsUIFxrFYwvU+Sv1KqclWHrr+aSLzBgUmnOj86SMafeKeYOmYuPoEtdcCnTkhrZlZMdnCSjnuzlDJmKnXXqjCKsZg0fq+vrsuVZ3J4hpYeJGmbvZxtx1tng3Q4zk5KlLemm2mYmdKYN37YVy1KlDKoLcpMvsdElIl4eWpqKrYwnGd4cqVlOKl42al6y1V1qiVvUFjBSLlAbLajrJmvH3aPpTFeqpopcjPe2UZ9M42rvqJLZIqWKFKsQ01737BMurxBlNp3Tl42zLrIhYmUoHzNO2LBPDBfgr1sZTWgaXSvrcJpz3NiWaOTvZ5YLYeFZjp2zVpEyXtrwZY8h9Q/0WeueH5Nt6yggW6ffsB4rBIiNdk7hOBzuK4ao1t8UaaMOJbNV3WEXKMnkE21QVqrU6FuxHuSMM1LnI4wlU+AyKU4UJZbbT63Lb9/PDDRS6CYXpJncz1ug0vXW82qq5HFQVSTn5Vvu8g/IL6BwDNoSUI3YZ9WSJQukG9jtCNiMVBSkOQ5RJ7IkVxvPqLRko+zk5q0yX7Bm0qXoLFRJlC5kq7DScEzVrOg1KGsmK1lKaR2T7y9S9ArZdkxtaY4NkR+x7+RnqHFZypyh5ey2EagSsqpdGRyVMjEvk49TkItQspfU6Y1kazMq4EzUj871YQnxb5gryJbJCqOcL6Qhq7ATEe9Y8yCpmKSQHyYs4azv0JVMrIlqlIzWlGWun9dpLpWoMSrh5KVPb2voZxsgV9XTaFzYjVjfW8jqrVrLazT22FRslFgaqCPjoUlk6Fck6uHX2GLkYuvYqCBQn6SmXJhOjZhy0FhrG5FcJG0RmZwpb6Jw56nJbtpfF2DrKuPmbF4m3GkbJ/BSIqUKHlKVTgtw8bNMYZCXkdrz4c1KidhHbCrRqcuwT9CMDxfPYnatltudCO+pIS1aZWqoKR1sMc+em1nlz5QXJE0zYZvly+eHiwoU8TFuslovTtsvH5Bcl1mxVuCInxri4uDtyqSokNjeImPbM5HcGSXSKLDjapAJZY4trOHUFgoysqAclW5oDpirsilOsmAMK+9182DTn+dpl0+oDukcjdlqjfStLq0iFmYVjF1rLKGUzBzqaKlqdxB4oTKupK1OS+sjii0TWbNna6oej+CuseRwXhoT5OLQ8ClJM6Ua3qUSKJRKypwoDi7rspBbHaFxIWzRnKUpH5jv9bNyjNAkL20jS47VsUvmn5iJiF6vSSnSItmUX6WdLNopD5TrMx6mmDKX5q8K414op2sMCQnS1mUYCnGPE9Umoh4R7koRIa+e66PnkY8gi6aKU7KQ1Y6laJ+qFyHXtfIN8GBplCnlls+noRl5FOIjZ24sr5LPrE4n0GWf0aRioa3zDQ/Tr6fga1GZ3RGJ4g9JJK1v6SCpGqqVaE4cHs9eZqGvy8qNNiUl4ct4UZAV/CUYK62j9M5r0iLub5GcJDYTnxvdSzK0EUwtEK5qGcelYV0jGsaQKc7iJBEgM2kfcFIsYyNQ6yRhI45p3aDl6ZAYrsXwFTBfmA6XW6Dpzq2PYRQgMy0VyGsVXuUa2e6n0ZvjceYjYtKUMuoUkl8qJu2W3q4wUpBiM7Szde8Ub6zOY8riamAnaCbdqQxZ1lT1rE3di7XZ4+QK6Iun2uQJryPt0JyX05caToyPZw8tTiySpRgVauhdbk1gIgzY2iSc6m+Vx04pDZAqXerVL8zILlBo2m3UkhSna56RGxnj6QvTHivpmN/N3xm3kqPh6+nOF57Z311XIN2u6YtrWZVrTCpVlqyyHs+w6s1sKRXNKy4bT21nExujCTGmTNElK+zdEqgQ8+ZdbhbcMk6dJAvSa8pM5B1hGwtXWexdj6ojErHQLl4t8lPbii6mW+7iS6/UZLRxz9EUadVyV63v86VyEcjZXutYV6xe4iWPLpxg7mNKF6bVY2DhWitQ1qDlE+mlFFqsoOKPlGQq7B0a55gMVemgjhg0R9bUp2tHJdSbzZIx8Ckopanasu+gXlD8OlQf25qcoiMP2mjuqtio4+/O5c9QSO8XnpcdMLLooMjKl3ChzdkOl1OeUY9rKrYi5iviJ5ucEeKgcgwlmmkdDO5kaWLLT1RuoSQetM8bzVQs7WUjXNlltV606SKeUA5ZJCSYXO6QD+utnWsaq3FGC+pp6m9RoigrMFWfXXJfSaXdqukQJ5xWGJVu6DPh51BwGCkZWcktIJDJ4CiXjyLbqdEoHG+emphpnauQZefj1ePKlVydXJIaWV02ZBYi2fe1TyNx2oiZWucncM+tnFaPW9Qk07CykTTRjxKgbSgUZlFeGB7e5FguMJYcr+5f7S5lKqhsiyTnlSb2Kx5Xc98t3dbmNYyOcaXd2opVcejwstrR1NWqFqfiG/WtV9YSZRKsM5grGHDU3GwT0WUgol0goxLoMovaTWcp5ZkzVTEOUJHUXidu4Vb0dRbQXimsTpHvYmsLspqln3CcGJKnr4wvTY2YFVZZUNuVo1iY3ycPUdxw4dZGrk7tXhyVLY6prV+cUGPWlg4uoHJb16rYNBgXnpAlrLEVEJVv8w6andynIk5uohjtMGyc1R+SHabaJ6WZlUsNrxpc6halShbvUTOXdNTtySzW7F7o2ygKmRJXng9eYNXK0memch4QbYz0IRym44zuJOv1kCGYFtws0Ahab3Pk62Oa11olLarUk23aLxgWjVhhHCyUK3BiY9aQH5+31ClgmmkNF7BjKVPvDqJU1uwok6mjlCxWYa6Pq2C0dVla4sqoHgafG6/VKlNrK2JZ3K2o4nHhT1tzn2kZ8lvi75XV2hfl3NFP8k5TcKQsYZTWFBZZj7lcqHAfXq7WMGKVYm8m0mPwsQnYCxEwmwkz1WWopQ9OqFuL5WxXadUwcNGe7hlUYm1ak7QYFx+uMpxu1ZMXD+MjbLHXnGOp7elhJKop7usdqpOzdSsTkzNvm1eR2OsdMuGRqhQn2x2WU6om0BfgViPR7JrfKpqjr3PuYKRrYw4YrrBoYeRPy9Oe6U4k6KPgqnT070+Uq41mGWo1Wl1U46Qe7m8wMQqanyh1z4+0KGsubmckrqVLDQ+jMlieUqQa2xrPOJUfHDUNXc4dT7bWDrQjNtvgoZQiJk/PEzULyykm7gt1D9yj92drlxaKzx6zH1GRoTNSUZtY1vBYHOrf06rlIq7tZyIXKjJSaOMZmBnsk+KeleER0ectVKYo1vYpszDNEAti5iqpLp3uZDWjHHVklY6sayPQlR/RkB0JqYpkqZZXc8i0D7QXFOelNVzv0FxonjGwUmTjVerNMyToXmWfCJCmqvZM1/MatFNhiifZrGbn6AqZ0mBr0bBSMxfSqhmx61mqq9+pV6vW5KQZ7TFSG+ykTwxTWFjfE7IvdJiJaI3RbFCoqVWv2k9RZjhVqMxIsHKw1qrZZaPhLeZWkS2rz6jt5WoYCUsLrSWVmS4vUG7cGiaiD9ixGd7rlWQQJO4NndnlSFsX0iqSajSUIpvizY/Z2W8N8+xhGXZiIHaYpBBfYSHJLQshbsVln5Zb5jZnIpFvb9Qyppdi7aRzTyGZ7q8bkmmI3/GLmddqoaDVnjB2NWRVN1YXXu8ukpXgZKVQCwzUk9dKKacpsmhYDW+wIxbQUyXQchUV817fViunbNiv4JdjM2pK9h21nB5rI9QMl5ebmEtn5epV8FQr0Axi3SojXg5wpBzmbGWNFKLUjJMUT9YRN40tcMxmIOiY8A2Mm7AJMtbXm5b7LBWeKA1bYt8K8DQkFt4W1GbXJJtksyhoYvqmLDJkldSZcF4okygbmCYZpi632F7l5TJpjWzmM5BTpgqd9Kgbo1IqKWJsCllNsdnbz1bjrZ7r3iobV+yXS2RbJG4o5+SkDWpQ64ibr43m4tYVSey1kFDlpXUzlpnuDyhRs04SnbAkmpZ1n2RmlKW1G2fox9Pyb+SinguV2YpT3ZyTUtKZV1Ero4mnnU8f9HHWG29ek+RH5ofwRmhuMV9OsNfn2Y63KS7rJ1ml5YUPsrFNMVruqNWvbeHnDNqv2SJMrO/tDkvyaJaW1eAvV+qNTaqkuV7a01RfZPJeJ0/ssiJNz9zO2Q8s8+dtmJrNUV5wVuHR39XzppnlkBD7capwjbKdXFEPpG1ppSOQFu2OEyIYqV9ljPGUW3GsKyTLKOUa8/VsEZFjqmTIqy1k8FskVqkhIHCTZZ3W7XOQlyOSDVvroVppbwwXV5QSlJdX+Rgl8Q+t7Q/IjYYnqymg3OMFmg9KUdQT8SsNq51krdhOrxROYmjvoxltptghYumi3+Mf8WaVkyZ2TspJHPAPdWbR0qXqV8z1DzcPE6ZO2+LNoeFn4x+f3+dK7Sav3m+na+OG3VbUZeHYzeTgLJmzjI1ka+5rztaaT1l1jlCbM2rbYTe1rwxpYmUIafHZc/FOmxmT55+h0XEd0M+WHS5i0snY8CGcK9Gp01MwMfKTlpHcqg7WIi7bslHe684TppMU4dGbjI8k4a5OrOUt1EhL2IlxctpYZQs2MtbimqqkZBUaZqqdpivP7sz0XCLOCyNpmcgh7xXJ7ddrSxip4l8kCiSh4CWS5BsZklyzG9RU5jHR6l0jNhDRqkfUKE2QqhDkUFmskmpy71yNbGQhFevP4iyj7ebtI6LiamyRsrKqKdbY1pQuFeJvTxktLqQiC5GWVqsycugQm6afnKNbIClxZ0lZ8itunyBQkWTky+zzkuK3luKm00eqptSuKtqYF8s2Y5Vg6BAmMCscVaQM5bNZWU4QsA2uWlo44VflrBvedN8lrFEMzEsenihwFtnlEPVVlFTmEGshVbNbHiSmLSgaciLYFfQ1ThefmN8o4eCOtVGtkWodkE9k3vV10qghRNqhsFoMTfVSGV4QG5renLcOTRIO61XnbJnSpqLfZVqVoC1fZrLZENBmWuJuEKyvKO1qqmYtV5M0c6OgFBUQ1bWeHdgMlg5sLg5xEgkgy7QrbBAiMdYQMG0gTEwXjG5Q3Z/sW6NTrWPbYZ2a3tqnXCwqjpGxGKVgat7Qqk/erV5klisXKJDxLd4U2C0SZY5pX+erSBRVaWzxx9QMpKFVsJ8V1qkYYqeh1iQRzemxmSCbzwqW726NWmwRURRuIm+pBOaqLeElMtpx72nT8VQxUmpmDqEZG885VZKUI7GxMhQScxHx3qjiF4zpMEzn13QbD+msUaEw25jpiBGUl3Spkx8P8R5Ta+6SmKqaHyvYc1Rr37CU7KjiLdSMLS7WKysvHS+aZKSr0WLyY8xT57BTqaURG06utozMJOsfofJPKlBSdI+nDK+k6VDdMI0e8w0U72ptWeZwt8+TKynZ53GcGGdz0jFii9jKLpkbJtsIFu7wM5WMTtOZVNHsdpWT7WoIatcf26ovIAojGaUYHtTO3HbdWZZNbWwhKW1QrwlGm4hiqJDlspTszVu1pKPYk/OXHw5VHDhfT05dMeAR6WFM0eEq5RfrVDMzTmwXrq0aD5ZSs9NRIGzY6FqhUI4PKi6poCKXjPcX5OcNMlkMk8ebmRJdltjmng1Zl9iSUA2xKp4poYrPkpoy5YzSZV5Ns5aqWRlVYjLw7Alax+amrataZ6WuqNPRFgpq0zGuoiRg5avixKsMWOfyJ3FJq2ay1OrfJd3lp5ew7VYlFx/tox+jkbPw2RgUzjdbqV0w7jIWcKKcF81hDVLnFRVflrRf2VcT5ZETbWkWjNcJiqVbJVgNEGAn6J1rmJiRDJ8tC/CUp1RrSZLhHymlybRrqlpqumdrkcwRZp4TJeGKCEwnD2jhoJXUKcyW3bSkkg9rpGeQ1qTXzKzskmoZYUxv3UxhWafNEFWm3RKWrahW9NxOnaRsUjMy1c/0sKAflqIU1GlP5Fiy4KXTyLFX5Q8VE9tVI984JOYiXeHvaZfNbVZ4jM73EU+t7UeSK5nsmOXZbCZpH1BvayHonBQwbhZcZBfUzpGid5ScWnEXVZSkJFytVw0Z64iwH15gUe9kamjZbJ3Kk3QubVegLJuYmtPXVl0bSk1as5Bg4qocYQhj7+zKW6A0m5MzpV7vHRDx6dIa0Y1VzvAtEUawFCSQ0/Sa2GauEN9gjxNXIVVmI9Ia2u3SayVu5g6RpWSSnLQY1x+SjaReclXwoNSpGncTX7ZeHvATUk7TVOdeVBiv6uywV5egq53i9yDQV2mX4uAk5JZyVVHxkaFHFFby0yAW2tcHMa5lIWxPFi7ccpOvWbhmlZ4VridtXJgwMWo0XGdmmNWqXK5cj5j1lG0sllts3mwZ4ZvXlhqUoyTVVImyshMSJp2KTVCkxCBrDIqIbyYvi6MkWpPf608Q0y0MVfDeAyknmIaaV6IxkKZrsRuZz86RY5JkWmGc1I0rq5+xVeWgWmGrFOiSsRBbKV2M4efoIufnDV6VJKLW5CfwyXQp2ZDnFnJlWS7nSnFnZR2eMN3R49T3kKbTmWsmre3hzZ+eWR0iLfKcKmyonpUtKuzyJ2yVrSNgX54ard9dFFYJXq7QrJNfjq0SJRmnHu5eX5UwUBug5B6ha2zv0o+Unk9zathq8BMeiiXvqtZuX24dKCUgMbMeljAVFSzUmh9b6r2qG98nVXTR7iSvTROkX+omFkuTL0mPZ2ggWmic082jmmLqre6xaKOv0dOa7xArnngMWJZjq18v78roqUkqTwr0VlDXWXEhDW+cbJJZ1OPbuxAWINSWG581W48JKVRPaVKlbN0naCrPXNrmVyaibFI4lhlz7JmUb+UlGCaQItFmmhsqH6cM3DJo5VjraBQQKo5Ly+8n825JbFlhdjGq3SFZTBeUnREmjabgU+7t7mpvTiWlMDWejZoyWpG4IzAcOFZV7BFujIrd8YwQHWPpkiDrYY0gK9TnK9Fbm4UyL7Oq2dOrZHHtaZrc7GczaxXOn+KkqmxdJjhL1dYc1Uuqy+4U9xehT1nuZuTu3a6rL9dXoB5g3i4iLenp0xbcWU8q3m3ny6lOnFfd8Bttaklm39quTOCRbF5zCZQd9t4h1NYrlNKrkK+kL+vJ1+eJbVDQUi/d+CTPKA/ZEPLaTWWf6zdOHRQwMdCi02og07atIWOrEGpJXd1n7q/Qp+/QH+ZXzCcMJKKetgmpkqydop2zJdFS45ef5A92UpChbtsVdNEno+UUtGZM7skK3eYWUa8cMg8VGI/ym2nPpu7kD/MrxmJpHLOV4uSq4bGLYfGn3qfNy/AddSHXm9pijxbTI7VMWdgh3CMuGzOxZhJPEhhs6mZNoGuHtKsf46qb15UXT1ZnJtKTmQ2hUCyi6tcv4KGSatgHZHNjanKpY2LPzdMq8W+dko6Kna2nC1JiaqhTmiV1VuFq7NaODU/oMi0V6RxnNVpsSuAWJtlsC86VOWDRGtHZZ2Uo56sZn1bU7OFk1ROg7mZumhRwI2yMz2k1TZCREOrdzLJzH8aj6KyVMpOv8qSo1CXjUp0cEzEdbAuu3LUck3Qx6swVEduoX68aHCbwpI/hbOousmnUHfNVi4ciSGyb2R+LHu4MnS+i5o7PlMydVNWc4ejT6KErmCsjpguuGNvSH+t2o5SYpuoroUslMlASc5wUCTAc8c9ObnQTkc8uHOfzU1EWYWKo5ONsjutbEPNUMdrazSbrXO5P9lDNMN6xIJTmHpAhGeasNrnWVAnk8oydt/ax62/UXE9W6iqi7W3op1xOWmXSMfAwF/Bto5fk5p8a2StIiOYs2N/cd5LSmHRXbM6Qba404u2a6WrrjKEbHzWY2St6FJHzEitp2yVgGp6d7vZYq/PQT52oyyEps3LWm25OsM0xInBPTg2hoinKkRHVo6lUWxiy8VqoKY5cFLBrdZMuqe9PWJHzNM4uhemgHJmyYFWlzp7gjqYQbg2NHpQaEmSZoc6np1htMRnJz/GOEdhZrNgKy7IkpBQUn2Na5hfrFwvbKaATFuJbjCHq0enOF+9vlZRiqhNNXZkhGKQfl9eKT6HhqKQgUokUZl6jlVVqDc6f1mnNUPSL0fFb6eqdE6TN096zYJBSkRFtsCzeYQyY64uU3mxgK1ATnDTVWZ7Mr+5a46zSllJjUO54m02LtOprKmGOSqsx2ohVsMeUFigq2B0z9SZRX+gf7ilV0+6oH66JFVUNHirTU5dOMewv3lfXZSVL5Jbi7bNVWFwpmaqdJk6h1w9PGGyhb53RjKEjXesfkTHw4ZvskeZYkbbxZF6N9HCjFLMd5yqPbll3Vc1WV+sjL14XIuJiEPBtppDU9LGbrdlR0OqiJx0tGdYOrhlMJRe2YCiVE6eP52AlUFpjFJrvzWpa5OeOWZFzGpor4PMRC6WNMeemkVfrLV6SmckOs95iEg8Rb2mm3bAdUl0mjSrfaWOdsnSMzlRgcCUjVQ/uFFMm1CFU8/TvpJxZTyFxqQpqsJ+ZXqEqIl4zVaQklnPpow3sZ/FM4e7ekPMd1taU3Bpb9hNQ509ram64cpMNEBOga0uLLZuzz981pmSKGLESaA+ii1Xt9OdSbB8q6U6TrjJRIxyX01EduFSLaAmKpmYSkah1H21aEVsNFbO1TSUbIFuk5OopJFmm9BU0iduzFlHQjuCpoHPV9qGaY6MgXFGZbGRx59J189vSTVeP3FgupXDT85besORIsO6jzY14TKUvZbDbWRxfbvYtjrNQzg9e6ypfqqim0inribBMj2UcWJrN5V2LVRrSouccZOkXc/TolB51UXiMoo5R8jRJaXJzGlWJc074oV4RFd6zMY/ypJowcySTHg7U1rMUM3BdT+iwZp6j5W2YsRdjHt8e3EqsKg5X7CrW3JCHjO+tRe1srWodtCnSXY33HFDbXGdZsF+Qq1WrZ9xvHVHdmg9kKRNf229o7lUqzykScfEsXiHOCKmqDajgnAoo44nqkgjtUq5WKE2irE3OlPR3zRDvYk2uYS3nqyZLyuzQdtSWWBXRsWURoFuWUa+SMCxP6G4UEmDX37QgaBgPcd8XJhkw6ZWwbeKMnR0rIi9hHTQk1B5OKExy0lPeXtcEaaKlJhPuLVax72FhpmNdn1J1m5xtG4vvWteYEheX5rHj1ZbhK1gp1dGdT2qYkRFsYWIatmzWt5mSnGvNZWejDG2tzeSPVKXT0KixadEL6BXlM57U85czqKg22aBhnd5d2GoVVpbfTTO0VK8yXNqQrGmoEJIsrtoq8xS1HLTspqAXGXYblZwj44pMsSYn7pK5WCEaM+SsbB9QH+5blaYTpfPVJVGR1jPuKeGSLDReqk9pVu7cX9V0cBa1FyuZIa/hVGtkK41cYNJbshyMXlZLjK0v79fVT9ksLxejDY+KnaPnGBLUJtvpnCoooQ5nEczQaGPV8Znt42tlcSSts6JiJazXi683b5wN5jKssHDq3LGbEt0dLFMsa1qbFZXSMw2cLLAsIpvvoCtwchRzEpwgHw/vTgvWmrYMp6CgzHDTE9IlsxvdnU8e8GrmKQ6jr/Lfb9uzEhnRXJzmIyicVRaxDaVfEdAkz+suzGsbIq9eUNiiXS8M0iV0cZlUo1DwT89M6+ZxZaxK7W8Y7ZqS6enJbdLvqJvfWVxPrCZVKLDOM9gRjg/rMnISpfOfVprqIBFlKhkt0NixlVJxi1vvi20lHjar0WQM1ukvbY9U555THTLpTuhVci8Y1t9Od1mdKPDXr4+yipCn46HKo1Fkdd3a5Q0YlB8SHcxUkZfT2VSo263tV2NJ3jDnDQvfb9LUqqZUoA9XTqiUrlLRN2ibs2wmHN1OlyNj5mrZH16Pm+Qlju44llbpaBOOHndRlfUKL9ehlEtQKdMs7uLWVQ6yj5kVkDXYT1ETkaOPnI6Kch/RlpJQllH5EbEQo5/llFtREgkmaZFb6FZoiZRXo3Kkj+ZobMqyalqJn+UQnVMcMI0a5dPW4FpxD08fMQtjRureL1psjlAi4LMbZm+hnBMdGq3l1xYXp9Nzs40cUtiXC5mpGZCq2+1ZILKoK7PjKGSO9DFT7LPYLLPib2JlNZvXqNux4CGyLGciliPUL3Wjlcu3mvFo7nNkpduWDc9k0NElzzAaXp3Od5guE6gTJbXdVdyf9VNQFDDumiVLGqqiUCuaH2YcHiXTjN/Jmooz2Veo1yTuI3Hz0vORsJppoVFPsaZn72yolXTL3QxRaDTb0AfTIx1dHufWXpFg781RlOfcz64XKStlZusNyijpVOZiJQtOWzUoaY7PV1nnTWHwV2Hn05JwI+1X7l4eGiASXFAubmUILNIYDYsWUDJpbG+rUeed3k5ucd6cm9cM9p+yGeLY4ilbtlGnLJaXXiKIpw+zpJ2aWY/MFHA2U0pwjrSzFK9vYA0Kr5ZPIBMM6EtqCt9lJdWOCvQaZaOXnU3l8ctXYK4J6mtadJETZfcpnZz0bu+IY1eX6OqeE2aTiexsX5es1UsKaxvt17NgKN+epI7kUCqMFVJq7RJoLpnrlSnvbgzRrRlSsM/uWVGdFrMN1d0xcawuMHBQjOfNZRzfFBUTTdZsIeuc32HkXzWeIdJblNnp9Q5zXyNxJ6+gGnJtGLMRK2+H32jgJ8yir1KJ7tlOZWpSG5lxMlKxcIlMZBloIpuPNFjhLGhVJvGu5Fniw/BGX49xrimKcKIJCS41TRCam8+cEm+lUyHnH6cfdvTbWJrva+KO0Kyf4PWvmGIPmMzfDurwZY9aaNKSomUNFWQxXk/glQ7qJ4sgTuPRsCcYMZdsFVZPkPPcoBLmrR2RmKXR3G1ieA5ozXif12kPtLLSZR5Pk9Ci2VII2qKv4eQfpVMuGFBpjvGsz7RUICKuj2RS63EtNulUSyjMSU5Q8CpoDFPrqSXL3pUhL5oYIqcMJN3zGDcZkhBNWPNmo+4xLNPjYq4Y7ack9BgY15StbcwHLmZccV+r7+iqiRpxK1spzXPxJBMfDU/lthMrzFSPJReZFdouVrDSlqdt9VFIYNTV52EUtJ7JbqSQThU2I2dWylus3qVTGuyTxw+r7IdP5CMd0Liu1mcwkcocLLEPlBZe5ZqRMCRY4+udrKvgqG4KpbcN7tOv78qwSiLeEtzpsaEOGLIO8O5RIdlgemEmmxDskiLXJuMmjFK12fZrDhMgpl3XbKoxk6YwZC9O1lhUyNLk8I7HpRugqdzeUnFiVB9nydjpEPJq5xAtuJyhIvEYimFijupbUaDxuVphV0oi321y6rjdVRtpn5HPbxKcoyTpbBauV+EjjAroXxkjMKLJV2gWkqVXbpPySEvxamXeHxiglfLMMXDYT8jmqe0pYCkvLlGiFuAccEpNm2YuZ2krp1VlTXdw0yEjjN6d0V8ozeVtntcfsa1ykSDiUEu2HidwbtfOLOwKWuJbko0PJ620mY1tjuXlT2Fclc8fntpxi+Rdzi3gDVpRrgrtztpS64vgo84jcCZOj7USH16L6l5bZpNOXu4TKJpcES6pUWztDpEOJmEqKvJmaOkizPQM89AI7K9aWPWoUtoWDi2WFFWcD9ZYoY6sipypW6LibzCv3YpizbCmFHNN0S6iEzUkbNwmikgO0dNoFHWqqSEKJ5tuJWTf21+z6p7dUc5Pk6RvcVmS8O0LYm2V3a/sjdCZmJmSKlpXVZIabi5Yk2iiF02l49ZQVaY3618zsWMjEQjiZFlXVZ7x3C0MVzALTdN3YyBjiu+r6HBPpWXoMazlbiSRLhBQEE5WmajtrKm2IbLRVhkvYdsrc8mfsOXtYA1iXhURHDDmVtWNrM7wsRd0HaajaNdjWhLY8Feh8/BsT22UHSmsTtDrs26PIZjqFt3tziEdtFdZCKVNy+RathBwy5ppZS4g8G5taWYU2Rnm4hsbNKdRr1BiV1mO1pIv7U8PaRejWCFZIJINXquv4I7LKtgu8tSgNiAYn2GUtKdOMmI0IJoQXY5a3iCQqI1qYxVtzSmyFRAqmaGrj5hOmyDsLV6hS1RaEXDMECke8Nbz7+CUGg+arM4dMhOOEB6jj7CIHwvim+t4cY8eIt4sjFzlq/Mc1vHSoafzVJORUItk61soiErI0F5uMN4SHifwB6Gabut1Zd3XZ1hwrA2OUC3oreputBBv1WkhordUp+cyFfTYs+eMKR6LpNns591eWcqWaJGttuCzTQtYUsxsVWpPC91U70jIWGLyt6LMK9eimeerT+zkVhqOGF/lYVGiW1wtFF5j0pdOVykjDJkO1fGL8CtwSSugYGJO11ObpJWQr7MYZMsQ7aDy4iowlmlZUFuRrc/uiwlijS2UD5+pmPTxaatlldVgImuXrZNRqaaQ2Wrr0+rb1+3unypOnRTi7ytaoyalcB3P6BMnk2az0g/dim5wLhiv7/HR6t52Ut5noQ4X8a3WlGaKzrJr4N8GX+2x6F6TGF3qrusPXS/sDBxYT1ipapLMmqfJVe8LqpPuCTAJLySWlXEjJ/Ih1uoQJCodop2VSZUYrd/SniZqGxgobCPVmBcybuswYJvLFOKp52eQnNuYaS9ScFKrplBTFhyaJnItyzKfmfCOoAlt6UmYHHINrYmrJ8vITR8ja+CaD9Z10Kbi2isco5Tbmdpq7Zwvr+6YV1ki8paYyqxRcChRDCPyDGYv4lAj7/IN1hpS0rIRYN1eaM3ncSNe8SidMS1brMsKH+SSF15u49yX4dFkMIqL52EYo7Gd8mi0kq2LFpQUq6eZDOcT3pbJKuJH3WDm8JtX3TiRD9ZS843vbl5VmBtzDSPiyhxRk7Kp8RxT1xLJVRfPHeUPivBWtpk0WaePrEmU5arqmOAxlI5O71+R1Fxyp1+Wq9mbjTCe7Sgkqm7PrdyP5Fec57FZ9F53puYjV+rurO3umakT7FCfXVQarB6tDKfj3NDkrC5gWqK1E6FzYirpbdUpWRNytRppn24hCppxDWsd7x6h8Euq5CwVYaeXZCdpn55flaDhsCHTsYpoZUshXkpr7pfa7N0UnSMbW11mV/MXGBmgmNAvmbQfD968FyF3WKbpRepKbdftNeDnTnQX8iYU2M3nGKndH2PfZRBmI4wg0BUaMWzcMxsRI6CQVyeroMlLnR6gqGqNW0xybKDZ36JpaSIGyitgD3Oczy5qjlZlnOuXx+hWL2Fw02Lo65/NphKsUqXd6qMZUNbe1u4ox9zk4UtXY+hQoKLZ2ieb3qsPkFXs714LqJ5VlK/Rbyic5qhxyfKMJp7jcCpl2ana4YogWXbnc1Ob1Fmk2zEfsicZ396x45ZiHmWSY6TobFqoohSWTCxdKdEslyaoDRBMoY3Z3nMZTmJ3ouBcXKcPLagp4K5vqFYmYpkc3Vdu7c5sK2yoKJjRzlTWrBaNHt8Z3Q9i2a4iCxE15xsjanKiaaJPGeWO5W/nn1rvKGqU6hQtWPScGRtrbk0dpRvmJFnl5ZW01S1bMplYDtmzGnHYqSwKrC2R2Vrsk0eo5WwR8BxwZVgRaRkvbFKUJLDO098g3O0bG9Htr5Vma7NKbUsUUFos5qwfJ91qm2weMKEfdFj0LBRa1uPfJ1Ma4BGYrx6hk+6XTuec15ZXtOKY1+wyWF7f7nYVLxMUZdDpahi27K+mpVauDasiTpRq7BDekaouGBOa51psIVMLjS8NKcxi768JqKWa2+hyHgusdGePseBgJXIo3C2uWluwYgohT9dbp6VO2KyaDykl1TDSW6eT6ZBjz8jYpazsTB+P1sz1rWCtKJBVp8+mUuhVJQxtXefaa2GhlhrxnKXgUuRP8Z6JiWvzoNWy4RDPMKoMMA7U9JkSNyjqWmodyapdKNuy0nHyrOSKaW6U8JeyGySO49chq83kVOfJzbOd65VaVfRycjDwr+4QJKrQKqUKkhbkL5ahKJgXH6uglFHz6p4wpdaPraeui4mkbaMTIvWllV0laprh5ZVSap3jNTLRDJQZtK9SoE/gcmyL81ph2+GmKqsdGd2ZHi2yLdASWGivqVwTKLCrGeAnNZVYlB1hnmgdFSEyGljgCnQQWGbMoLF2DKFjSZ/c6gzVNmmb+uKb9Oxi8Glx6aygsKRepVkV1NDl6Clj1MtaX1Hwi1JwM53PsySa54/NHdsR8msrVC9Sn2WSVFRWnbDKK1ScK+wqKXEh06Jb6/Vhr1rmHYomnHHTqexL6xGXpZqXqq00ox+XycsTLqNZEzHUTOzwHjDLh0la4qPx9JwgUJ4GxyYsItaoieJaWVLgVQtnrC7wjGyILkvdn9XS4oxOX/ROHCrRR+OkTGmnc5OkFBKd39Apd1sNzBXPiRstqA9anPBhclUT4eWs0ZMUXmVuI01ZdasX3B+K4Wig2Ghuqm3sIRNWiuCXnJruTieVFE4NkV0hzO3UTxypo99OUQ40G52R6VRNp7VYVxHhLxthbDKr1y2NmCyXNG6h53VZHlcdXjRnTjMl4yHvceIO65Ey0tIVlOb1pjLX2bMpWyIQrmkiW9sxSWSUc49xY64kk9mtWdqo126hGVoNFWldaFtmGBSk3pCsEbLX4RkTM5GisR5d7ZgMy2jP6dzU23RPLs9t5JlRXOBQnNGX6ijQVFfmoiDf0Y8tpGySkzOk3BwkqDWUzw6uVmMhIEzkS6oN1J1X1yAKUOZhLKVoWTZIoyQqj6l2Gd5f70dqodOsVKSlr2oRsatOYpmkLEfbXa1OW4zeKSkmbQtR9g5iq5ScomNrIijskVjQa/MSFZpyE9JybynqkBApm5WO8qMXcW2kLdAYDCfdrhGO0GjzVKDsyKNvaBIPmG8gpBLZT/Rd3e/UG7Oy49Oy0A0qV54qMpXYitJviOgbKo0TFxHjZuqcmthhVzQuI9Tj3qZsKy4W8EqzM5NWYJPc1jDxkCV2HJjNlzWRNQvnDlFw3tOxFYx2GeRoi94a4aOU3RoaYMjk9BbvYUhn254SCpPX6Wtnnybw8+lkqCKUaHBN3+2ZGc6VVdZkE2tnYGYpcdswHxcxpPBJIwq2zLW22o5Qkpdi7xegYSAV5Sw2DEwrMPTZnJhvS8xeqluPX5GlrtzUFfAkaO8SzuKdpOsfmahar/FKJgulrZlMm6kmKtKOrJt10w/wUrRX5JPlbXRVleuO0+PITV7dErifHuxbKutKp69NzYjrEzAlVRJXq2CXHaqtM16PqVZRn57oYMnZWukmVQqcCeaabB0wTJXe25rQqzRknSolG7PTG8xyHGwlaocbErSsIyAP9I3kbhCg1hmvGU+r1cmtaOdOlDKvk+hzJkquUxwcj1emUuWmkJIqFM5ompBOZzINWfNz4Rzl35VRnBrYotz2F2BUpCjb6RYtzeMXi2ErK2P1XhqlmZGeaI/YTKRezdQv2iFhIehWKplsXx3m8WvrYQ7h7/Ioj8xa85IkiplQjSEJzqWurxgpbt4PHF6YC93KkNTaIt7ZnGzqzJvw09YtEqJZ49IkJCIjjx5hjpovci/MNdHdmVasIw+v4LGNMo4YXOFd0TEyMVo0WS/MU3NkaS+uH08tC7IxaM5tGwuhqKfOGdRm39AoGhYR6x7wkQ/onOeZlaMzTB9f1exzI9UpqJ5pkSPcMu9w7lwwD85zKMiy62HepIjr6uUdCdpg5bJgbBxOKm+VGpLHaKaup0kP6C5Sqgtu56osKaiWXB/l3Rs4HBowW2DijKMJCKzZZAZwI1ENX/R4TpohaE3frM4QYNlz4qSqsDJLcRvSm3EOGGXcC68Jb1Uu3fSljijd1KZe3iRbKGdvJqlhL+lpXuct8rBxcmjb0szypVw0D1BMcI1a9OKgTlBrFowu5ZseJdeYjpxaHIoL3e4O5NthzFzhS7Jx4JV4DaRUXY5T8OFJXLcWdx1vi+1up5eYcDKfHdAGk+lvrKKNW1DYJo+UVDJrcZEe5gqN54fxr/Loi3SYEo/s6iRkFO40it2K46vMEA03zyKzV5bW1HVola8pWFGaq7Ob2LIzci1V1XbdGM9RH3EdENqplVE1lkrw8NkyLhzlGDGcINnqq0xgEiNU2ab3k5MZKBFPbN4XamKYcRgvFVPeZK2U0cuH7EagSZ7Sp0aTL1msXd8RMBJsLFCv2THi8Ewy7RJs5aiUDrEqNhY0cQ34H9rYVdDS62TQEdTf6pk1y9U0FLMgX7FiqOAqXPNQ73MbopPaNi5S61Ph066ZXHcRbhMbjHbUj2nWq5afY+mS8k1kMFEZpdKcKxXfly0SlwuxzuGw3/Ds4CJFrKUs3yUUHSSQkW4MWy2WV6H0Sw5srA9i0TDcKRAZq58nFM01Sc4e6IboIjQKKlJyXOda8JYPHKzwzee0rOWlY2YcaEpWjgyvXNBo7tUgo+oVlrUNbxXfYxZQoZ4U7ahv5G+Xl9dmHrLjjyBkZSVqNPLk3PEzZpcuESTqZ4oNL55x6kfXYC3HcdJZGdKl8G5OE97Js++1IOGG4g5mD+buGFseMyVahLDYoxwWaRsw1h6Z3vAYaxEOlV2iUtClCtAcItZz07cbnDF0mOqvl04GceuYIOozT9jOVqvS1Mstze4SY5a1o5MRpWfH3eLIKYexSyAxJtMkGlGbbnVMculWTlrRjpSpeCYPi9Ghc5qnm4seHCqYa+rIqjEXZGzTF9wibg4p203cNs+0NcihFidQ7nUtaKCvkO5yCRuO7WKaY9MgI+gxY9SZUp1XlyIszRzwF5qW3WNRC7Shce3v9BcO1B5rVFPe4t7Wo5i3r5jtXkpkKg0yYOmPm8sTLJjecV/c681jTOYP6VSmIdpH5XFjErBMGDTqDY/0LxhM8ZQSYfVJ820bDlumnM96rh5R0C9u0xPgFpuXNeng5tCYoEmgydnljcvHYZvaY1OO0aquC6Ag0lMmihenqQ/QVOiR9ZbcHu5O6270SWNOGp7sp63REzRMV7HuLp9tDSSkW+EWsVGbzaEY3HIS3uAcqFJp3fLjnGQQXw8eK2l2EZbtXI4w6OINYODtVxPrMq3SJR7kcG6hj6TeYQzQMaenIy9u6NvuZsPoqR5dYbRncZCMkdxTH+RO6N/kMt9L7JehGJb0Zw9h6YNq7SaOndPZz1VWHGUgThrciVrmVZtVSRWZY8NnZChZahyP31yopDMWLM4U9KvhXphm4ZljkdalG4wezRFhrknJbOIl0uHbJGey8OMOJGSrcuBIH5+xHGPuMJ5isTVJjhupt46YmMtv6YldlrCir0qu9B5fXmFunPNidNvqsNwuL2eMjJ0imCmtK6ffH0opR2ToS+JeoCfkqvLb+Bwj4GzPpacrnxS2HtRoMW6tEEjxqJ9ZCmPUbK8ztDWJoVvpMOjL8egQEirhSfAU7FUzEzIM25njJ9nXJ1AM0faU3RUSLgvhHZUcLfcao24pXuePpi3s3Mwji7EKlyyQamOLk+J02fONY5AnT1TvGORiJ+UZ0qUicd9kGHQi3/Lcsq/uSmTkoWSwMY9WKV4sWOkiphWgrRYdZ5MQHh1aqlxQG1hlCJsSGxsz0/hZjzDOXOIi6ZgwjZTk1Ccz35QiJCVyiSEUavFdLDDLXRZXtFKgstvToxjwnLB4GlwRotrVKlpOqKLMKfAaFRVeX1EsnhY52nNRJJiMpeVoD5gnKaKO3ulFrq/vGikds3SjD/St3LIaU9EMXuqN2Y6MXRgO0lqqCrIVqbLmYBrtmV/gGbCPmaGVtiIxTFTeKVqelOQV0UaRYE2k4WkNaNqOs5+lIlJrFubg6JRczBXikOANt6uLretFGmvpdHJSmBql3qCjsl8acV/rl0+S7aKlGaAbm9kcYlQmjV5Zq0qw7MnsDeiyEWZhLh1j7qmt7tzvVBsVtpuL8TGpUSShJshN8J2pDZPPp+NXYexoJ6RwbMwM9WKgnqMNmbM0IKit3BEkkIfzt1DyTwuX5K3kpY0dzttl1heQIqEICimxIW8UJBihrQsvaanqL8tvLyHhJ0ig7+cfk28oUIyMVW2PcuNJ6h1a0pGTbh8dWWZPUtUIFdB1L6BR76+h7qzoLYziovKubpRopJzPJZttLtcH6KmwTB1x7JajOHRZa6OPIc61WKZUKmEHqwef72xm0RtuW6zfz7GU0fFPMlIZYNxNjBJrtNfQ22SWEeVYtbNeUOnNSSy0r1yu5tnepmJkVpcRTefMaFIZLaxr7VKs1M5p1CfdyZmxoNCsMeeoJxrxp9joYmfWWnAZG10gltWj6WgQy+nej/IviewqTCsOcCcu6mevIGGd2zHuM9sL5mEctdWP0TKabh4ZTXAT4s+NZeCqR/Pm0JmV01tiTG/YMWpjj1ub8E/ZzJZOaeii2QnPY9mjpyLRXFO06A6xKBUrHGK05mXeMI5t62JdYFbx9UopLBDP0EsKbeMnieSbmw3XrWLcXdA2EGL0EiKvo1pwbYuv1WzRjxugbdMqJ9SwpcfhXfIPEm/gTYrF8O3aiq2NraKkld8RcQ/hGbPeF1JqFJfrh6Fjl+Dg6DExMFRvYHTt5uUWLrFdnQ7Qk6FQ20jQqutpEBvfI+A43y4gy0wCq5YS5YvXYRfz1ZOuSV/wWw4ai1rOHvZzViPZcDOoFJhxS+8p36Khjt902XEL7V+vHVSdp62ySUuXrTFfiW8pYGLRctWtq5oi2d6n8iJaXBwHr2Rb7NAKytEK8TFhZlumnjDbEG+oTh1QUCMQalfyYV6caePqmOfVG9KhzU6nzJ+q3U9Q48gU319bJJFNj87WL+sOl57u78wvTu1jWsgrqjEsGqDnHx8qGSUlS2cvr8zoZwxWWR6LKqvqLe+Wh64wLEegs2ykK/OQkJ8t2VnNT+QqjJLtFR9Y080gCiQmGOKv5bOakZ5zEQmP5gcYENFO2VpOXzYcblVZCqGxGCCvDUoxLi/LLSaqkalWGOSp59omzVkppBFNaSws5udQm5SzkSqrTZfZl54VV6GhZGUwjewMDRkZ2WlvIV9WM3VrnCjU1ClnabOZOTAv2dGKcgoUaWDVkXHSrZxoiE/q9CN3FEoZV12o6VHQKuhaTSxxLClq3Y7ntRT1DuIdUaMb2KAuMwq0mO5rky1h3pStDukdFzQW5dCY8ZgqTWscKEyZ4hrv0tboV7Sgbl5cr6cSa5GxoTVXMlv28pjT9GHlWi7iGY1yJc+go7uY9k/sGpnJZhctGGTqFCebL9gTruPnG9tZqZ9SpyzIXYneHdYzpaWdpNOaGOdNFQ3d4k/bVyYtHcRnqKmO5svsse0RMk4lKk+iL+iWX9vaIyVv6FKcWVfY019NIFeUFrTi7mmzGovScuChItrT6bNoi65uVSoW3WtWbuqNzOYhFIexShIiVadtVLIPaxieqafnJh7fKN0z1uIv7+6nKJlgooyictZfpurhrqXUb9GNXBGn3OUdG+TIB+Wdsl8d2dJw3RglMZ2dWltj4aRj7IuO3pZZKBqll4uoDd3UUWpRps4kFq3rwuFRMJLQabVwl9jMLihiKG5aIahlcB/Z0lTWb2zvONsWNwzvpKucXSY2lJiOaHCZpylQaHIkihu0KG5hcSlhYmdv4/Hid/EqGiPUNJOoFUodbdwFmS4a8t+U5xu1kU75opxdLugbHLUsqMzb8OiZZ2c0ZAtOjCHL1nMdYplhlM2tHmhhZCFk724rXZxxFRjf3JwalxmqrIqgn1MajfELFq9hXrHa7A9mUelRLSjS7JWk22iZlley24slnpvfzVRTTl8WMpVRb52bFKMgbpuplsxf1FhREh4bICkYWIkdqCTt0JFu7N5mKVXqVZvJG1itlyRg7axHHFnuWqsWjh5h3DImbRZRsOqsdktnGOGKXinrTywPrSSM0LUlbBgS5dztK9qpoBMibvAm1zEdcg7hjVIx4IzdqiCxJcnlEa9I364SqZYtl9empDUwbZy3D+UcUZStqmXp8KHkU9mdJVsWECwXplZhb+yd08/wJJCXoySpJRcVKLLQ3Zxlro9x1nBPDaPUol6T6hCWlLHqH9ZRYTFMn5cgKV8Vq+/aEp2Y02Bp4AyH76CP3uJGkhssbawaVNZJkrAG3JikLGxWLi8toWjopwtsFnFS1+DhVVpQragHKtiW4LMdGjAtKfEdElDbcm8civNd4GFji2qReLlmaC4zURs1Ea4n51TlLeBPypxSqu9ZrJKboZ0V084vKFdPSHJuaUxGpilq1hDQoHdR051lX5mSSfNyNp9Uoh/dD5AwIXFSTRHdohEvEF9li0wmVmV0tdqlmpBctySVYUvyKh9e8CQNpCFgDQuiINQdIF8edNLLdZBg0KiomNbvTR3f1VtX59vuKC/c7gzhruWd0IggX06qKpQS0qvs7qf0H96ZTIvam59hz3Pz1dQgbfAaIJlc8FHkFVcuIfDmZfRyY9vX5985WjWeDOSkkU3n1l2nNCpaTZrtE9AuZ9JmZaipEDCyk5NSkpt3rlYxKpqgXiRlrG6ZCtXdT1JvKeZiMEj0IiPecKnU1QtxrRVSMU1H516RSlZgz1xQbVtcs96o56sM4A6VH3XdzXJeE9kRFI8TICSvketkMC1W2BrVXO4jE2eL1SgUoyMiGugp3Ndo2+qnzVnOzM/rp1rwDeGzVdMbYsyRbtMwsEbnWIx2EW3M8HHo8ozURzMUoaufUahMFEekKeGirLEgjB3MdDCcVI6PNIjj519ba6VOodvoKE3uiXEMKRzSXR3aYiwWdSXwVOiooVVsGi+qCMXvleayUGOVEvJc096xl9TO0tkgmNS1IygIpdlrHGKIj+co7Aso7h2xrqgrmOVU2sZV4oyHrTLj9lyR3q5ZlcTzsxLiz1fQzRGsUN60KF1rUTBTme2hXTHuVWodJ6dZG9DXcDallO7Z4hGwo27gsaXOEaTNWtNOZu4YZB6fMnYRVtxNVlVb6pRW39QgpbA0I+4sVlppJSkjDxzOKyR1FxzokaAXuDWZVhDdlmEaa0kUdfLKr6KuNBIW9epJnmziJSOgCJiMlWre1+3UmQ1xk2uSGBj1M+Xs01QyFiHwLW9oxosUzQxi6tRg9CbdcJOkFGOPlNunWCofD9mskfD105gm5hEnWJibMVRa3yqYnh3gYOsxi7ZUWxhkSi+ZMw6WnNnzG6IcaSDn3I7YXlr1VJTU9hmYl26t3ovfHhUn7PNKnAvi4qXJKPaSG59zCFei8qbtylMvYl2fFVyUYLRgl9eVG3Bc2aHRW05t23Qi2o24lUzpUywi7l/U1eEv4ZKborULL8tXF+wga13McjDJ8V2MKupt1S8gdWalFnCnlNFNZKloCzIrbKJr2zCnqzIdZtOe3e9gnoqo4pIippihmmrjK9nM4R1daCaUMV9fZg6KK2hNnDRb2/AqGdVmVJnPqqSt3dbfKk4mZJQ0K94Oma3UFXNXZ7FlizIjMSYraJ7hCaKrJCSVZ5zcpJfVmEzj8JJoJpe1tgsNCmcoTPBe7aYoa/Wgr7SXKpHUFDQNp5OoHdyqqeeVCqWuUUwNbdsKsOVTT6ZOnQ9z56BPpI+sUVllCykVs9BZcevSzdjr01h16efOU2CZFdNqjwqm2dwxL7RlT3DZos1raplOi5UUn1kwqbTnKaRr8WAhmiKY1Qrz0KTQ7bUlDuzrWYhh7ctokRiRbzYfD6tgasgaLtyaV81lnZPgpmlZ3I2qDxXidNLUWqtY0eiRM6hYG7b3jIpWbe5zZ80aFqXl205v5JzPX+QKJpKnWWGpbqkwVOo1Kx4cjSVdq92pLS9vV+4zk1VXDRvpcuvdqh4UnRYjV/RSlrKpE+Kh2Sg0JJp0MVonXJXrlxIW2FDVkK+RcR5u1LbtozFiXRZVXq+oUOWwaJonrWTVLl0SKlFvZg7OGxIZadmuTRsumW1d4p3qj+Kuj5dQbm6LMtsckFlkmvKOaHhZEB2s16Ifbh6SHy2x5Nwj0cuLFx9yatosDlWpixjqEkipF5OY2W3l40mgJHJnT2jnsYvlVy8J5CdvUuVPIGlY5esr2qkzTyKsKxDjjsims9oXqHH0XwmtnRylZVnLKkrHdHRPTBsV0hwgXyrRoXdaJm9aUJDlH+foI2YPl2jnkbmSEU9wKs4XCaALBySFnuYyLQ0ppBfyXHLfF+QubquPbijIXbLbHXOl1JOeiVFtYRub6WEJcJrk1OPO35UXkfU0ZmcRlGyvLNwNYLYs8DZdqmJy1LQyabhOz3AkFyvYGF2PXxklW7KrWxlQYY7bn9Et9rUg7greoe8fEF6mlemiYc4dD6CVYvCOMu20ydL1riimkpDXKGSIzCkZ7FFOqxKXYRyiosqMjLSYSWzvy2DRWQxq0vF1EJ+X0SwsL1HxpTXo0q2u1FvPaa7Qbw4ey6TbY92OCnSjHm1iHaLzk9WfrmTjsV1VDZdgqpKf8FuZIevsD5lsEHEV19uTDi5YSjIdUxTpc1lciekZ0dIqkd8i4o2wZlLgFIvQZyDtGlDvrpM0CKtxLtyvkO4rzeUjZ89SXmq0KNSd5NbSrnTdIvYQjaVvZJmR5a8gZwpJ018wjB2nkwyxrNsrtmDeL1fabZ11aYzQjGeOaHEqrU+jq6Sh2tbnTONryW9udNM3EJPTbFtr4MmqJq9dVa8Xk+60lZk1U25drY6ukowm5OudGppvSM/wSScmK/GNYBXWJg7xZ2yvqs7STFse6KBIp2LyCJyQREtZ7KPyHatM4G5UKd9IDxGVZtBSlbAP5zOx2VEqizT1MawhKtnIHGghm1A1pBrc0NYu2uGQ1N50HEsqallnchiWjpd2cXHWTWnly+BoohUJ7GxZzlgvVBCZ0qA17lCQ6XBjoosyTuLI6UvfCWIq3rFcsYrMEVnSYy1lZS7Z2Vhc8yphiNvZ7J0XrhSPs4vqkxDq7w6bjJQdGjSsDmDqIlxhcJTb7h+TN1pXLk3wD5mhUu5h0tsgk2ZeTE7x1JtkTh1fUXDby+fy5RNwkE/eYormT2SaFRFnI6Mcs9FXdBeTWKP0qaHW3tBRCanMKaWinc9W5hUsDNqfY9wxcKdZZxHUD+Fl0lOmFySS02WhNDYW426o3SSrHufUEhaR3WKWXaCKbqJMpqRwGFArYJBSEZKv1KOfFioi55maqXBN6gy0ZpGkpeCwlKJxTdQcnzIesI4qERrMFy7WUJKczm1THqSgCa1P4HLkUFKaiyIjj17c07WYeCW45JkdnGTqbuSLn1tOEqVnZZEQY+spKJjN8zbsMV/nrR9fF9RjnyXRT1sSbSDv3ZVwZC4jDw2r76QxDyhMobTlm0/jkm9d1+WUpksdreuRnFsi2hgqTJ8LkEzaz1peKuzPLzKXlOcypW4KrkvuLozVGCEjsRCXTJdLbq3x7OKIV7CiKW/ulV4RI5geLRicVpPc3J7kqu8wHPRS7NXfsFXxHtndTKAbquyiENzed40Mrt/vq5njp+82c9PoY9OZL10kH/Ng114tZlvk4m3oW+loWOVybd4ybgpMDN20Fh/xj29YGdQYGSFN4GPeWqutT/MkclRs8SyfMLCKntQzUKbL7y/eZ2UaXw9c2ddqIOMSqGbZpIotVG5TbIngpPCV82Hna9IHa52TZfPfG5CiENCvpa3Wal5TUaI0c5DmIxocy+Ztp5EtzHHVrSIcDie1LCmmVp5u3Sqx56AWWRKz8yGjrKgh6hxibykimWgoiZIyGaWgkO9mXVRoayck53BaXQ+gcSBNXE5O3uTK8OlesiKlnRHodNqX1ykl3OOOHrUe8JSilh7S5VF4NaaRVCEb5R9V76lvYW8WHpaQKmd1MDOf8aeXGRXrpiLP5VjfzrXRKShXxSmYLRtSi6YjddduL49lF54S0rTua9Rdy5rMZ5AMtw/lF6XLGi9hm1CsI9cYJKUiJU0iixboF+mMitew5CSL2FSoDhTxjKyNShbWalOLD1PQ1HHrX+Fi7eHxM4zcbdrTVBClpqNUY1Vy4hxeCWuM26RaLmPiXPJHqg+cbRifKusLTuG2JHA5DKsonK6OTKph3SFibtgerR3qX5Wz3yxMEK2UOVAo1jcU8xbUGEtPLSYdmovbbF9RqxxZH+pbG1ik0TVXD9ddcjHrbY+NaeDusjRrFybgF+MTopsg7pMonSLd6ZPPFyhWUxMvZS2i3xOlYtXh45vYmBZs0oxX4jOezl2NG1wLq7SfJqdvc2oL5jITNy18KqVbSNTnpYiITAqri9lpbNYoZYfHpCBfE29Sk92uU6tUGh9g0c7YKq1sIB5SKNZszKIXzK0OIxHNDN0sr/Ix7VMx26KmLmdMqhTL0JtXL9QyWI00WBNJnmvjqLSqdRLnNvZM0pExXjMJTGYPMRVK1q4bjadUM1rSp9zaaLNoyt/PMeEjYetcmNefZSHlp2Uc7JvrUJ1SdtuTWA8d41Ji4tmM8aNV2dpZ3I+onGDvHxdsq2y00gxZGjSb7qih1q5vFjHclZem2e0gTtAwyyImysi06O1NKNVlGVkfl5Gh35ALjGiuotFjc1AyVQyUYM5gHzIN2pzslomQYrVt9OyrzKByL6ImGR6gYjXLrdTY6xCssW1qKnNXDCUdWejOlhCqG9Ve1tGZp2W2YnDc3V0sjWvkzXanjVwfs7DM02wUpuwTDt7kiqPKEPOPDpQj5KRidE8m8dkh2q+kId4StNHmEuocbKcqnB3tVGKIYuZoii/XKOOXswzsohyxlvOa0e4Vb64l6DSklZM2XmATkFArJRzi2mEbFZQlVbdNy871KNlcVmJmXhPm6AylI6ncUKXWm1ZVi5xqD9ktT+HLGlnm5RTPXpAdrKGc6ySyW0kkZ6GlldwplJef4m/eHQ9ZJVae5tKgsN5WtsqMMFHviVssr2QmEmxzilvMD+GcSNXaD1ljc+2N5diMrSZmpFExWOjioFuhKyCU6VM1mPXRziLgovGNmiNgqIynqGhil5naoM7PdsyukWuvTy4QFamszsnUEmXTthwRHHRxL1FQd+5g7d61k3YR086iWmGt7NXulaFR03TvM0lZoi5b1R3JsyphbpOq3jXpYeUsl9BRS1mcU2Do5OIgJ5FPHq7wsuuoVN6tWR9r9O3OzetybQsvoS4xyZbwmqrjU6wxqhWY3ybWGSKiX9ZayVXuy1EcjF4k1J6qDfONsp2qUeUfUXRS4SFNbZgwaKmP5GBM02kpLhflM7CxFBCZGGUJYfHfpaCuKSXqLy3RUl6k1O1bIKkyY5tKDpFNo/AQSq+Sohp2V5PfDTCYyqYRZhJWHRY0FgqqrOntZ6qon6QY5BeT6ErzpqUTpqxqzdcK6mti4swQYOAg1fXZbeyScPMxaahnr55Ka6FsU1G0axsRpCFZVdOsHyGPzvDjKLGfSOsQL6hmLmyKz5Ad6phV3lemNM/zV7RulwyXH6oSosqXi/Pblg+y863pD83QY1WtMqno4+4Yk1JWFs4vVTFqr8wkFSYX1tmfki0lMfMkLGJm1ZFvC3GWM6pSX5zitRdQLqxTGo6jMBggFdGTDOFglKnqy17g0BS6k5zeCY1xqLMZZB8a3hqc8E1m29/o4d3l0YheF18xLS2SFuBf89p0HeJrIE/bHuPnLlBmcRwxblDToyhurE9V1xVdIygqNeLpIe9MS6FkiB/koqVUbLAfoJpooOtM8Ktgi6vaW96RsqEqJo2l87TK2lwNZ2UMWd3xlNonDQhvXZRL6mMmU01tSl0j4ZINUDLgTlMxypTm4Y0Ml1Beaa4U6t7YH5eRIWmlYiiXV05oW25knejTclwLTEnrMjMvoMijySdkniUg76vuERqlG2NllJ2T5BvWjjMsz6kglihrS2xWk7XNS7EpW5AM3Nl2LBwWWFOvq9kx5Y3N97JZo9vvH40hk5RfZTVfqE9cqKowoQ5bkxDzWSisotjp19ZwcB/oT15ioPSpYo2xUyz1F1umsdLOphmtas4gkKMq3CeTHSpn3xprsJZeYmdwDOVOY55uaK/aTilQnJSVXul079fXXOggSyFyMAw1Y9DVR+1G4tGR35wnUCFP29Jhcivd9+0P7isKU3AYzttcsXXN3kvgbSQuD9QfcLOK4ijYFExM04iXcQhfUqxp5SVrdWLfU6+OEnYgGY7O0SfQLjCim2S6F5Xoaefw5pgvGTFoNpcZTyCPYx0e23RhkDB2oWXY4fEM3RydEvaVop8oGKNK1iBPqm9rWitb1mnlbB3nEO1rF6ZZJ6plKuMKmrQsjA9u0CiY9fNVqmKO2e6Q66egJi6ZFXTWEqGJi7KjaxprNttNdnQpih5alGfqXK6wYqUTKnJooy3g8U2vGZnZCNCZ17Ltcxdr8aROpy0EpRrr8y2HWa+mHSSRF2kQUwzXoB8TLJylKBfxnlXcX++waNvgqExhLCqL3eguG+mf6qyiMh+rMhmUmlgjE6E2Zm9xGi+fjeTmEVqYqS1K7tQvY+0rlZkba9FoixHpInILttmRNCZZcZujIuQoo4qVR8qza+r2oBHmZEhy6HIm0VynF3XK7UwkLOLsbc5j21uhc5mYXRKwa3NramfR6KDSTdWlzQ2tT3GPUa/tXWoUiOSNrsivFSJwlyYTtx8TLI6yF/daVaNEoKngUa3S8KTmnaHnjS/QJo1k4ytub6QmGurjzCK1mU0YshEZcc8W6QsnnirrK+ncVtIvES2Z8i6Pn24T3R8dYHDzoLNOiqOPS0z1XectTeQt354O2c3vYYXnjdSL0TPlGg+VIe2IFtHal84T9RH5d1fdqRsbEVVWHWb23GBWHiWvCpjiBdFnZiDsmo1lbdC1jrGg2qg2j7jWo1V1jqgtHDX3VFSr6RVWSxPhobTXpbMlqrJr0hWii49xS5BbDKXdU4841nPb1HWXqsudqyai7SOosJBJo9RaZdkkIuzN6ZVdlFGeX2JwpNeJVuOd8Z1hU2kh0meRyxep8yrkLKdLy7FWHrWT6uBf7UzkLhkl23OPVxNVS13TzJ3Kc6KL0VYmEF2aD0jsEbGcI2acMGCe8pbfYGuWKIwlmrDYzPDbVU8k5pZ0MCgimpWp551X6EvZjdJNcKkx7Bstjp4QbC5Yn+xMFU1iht5tLN0rBS70FuBpCWvRle6TI+HnalCKjvMuaSNk8c5mV/LxpohTTtZn5EoNVS8cV0zkX2HNG6SrVVBN9S0S0qfhrycuUCUKj+eTMorz7w1ejE9n77HkEKBj7CGylhzRKYlmEDHztThuUs8OXxstjxDhFKTrL3FZ3lTbGB5yZt8wimB0dd9TUZULsbCq16jM5nbbthWW4MsY0JXj2C5ls42Pni/p7lejzKtv7yTSVKqsiWHpMcualmtkm3DS6dNPoiSbnFPmkN3Nm6vfKu9lW6cpoY5sqPFZqG5P6J7uqq2qGAmTkkrY7ibNLF2kNFqvaZsnJO6wI6hkVhospBiwcM0JNKRkHWBQXRzYk5Ndo6jzZbGj72sQkGST4+Om63CsCF3IktDVYQmfzh+ny7SnsFIs3y3S7aaOGNITUnAndljWpGiiD+cuGRtRGaxiYG+XlKlKr1GprYyjC5sZYNweTq+Pl5bFKkyoDxfSzunmaakpM2nrHISwTePgN56l666U4VIjllL1HOOlkavu1ytU2lnNF9FSlWhRYOeoKdfXKV6JGs4cW6cUaJPUrOkKNGkgEavLq5f0mUmpcdvlpCwVhqwmrRrLyGIrLS5Kz93KMtCyIpBuqNpUr52VpJ1qDSJd3VEa0q5a0K91CvDcVGtPGpKTGCEp9NAW4rQM8GWYpWUf6R5PG+iS1w8U0Hex8IvpsLBijpGkrk4RMtYwIpSmKNfG2xWbU180mdgrT+NKcSMkoqGpbk4yJkmp6VsRlXCRFmDbSEpsqU9WtiFMbNvN19pt3Zxm7ijfys8LXdmfVSpoT2USFQvvEmMWmA/p2h2cWSzMZtJiVeghqs73TJsQmyNx9M7yJ+qy51GKkiKmlQ+qE5ONnyyt32xm52HiEWUWm3GxzwmZEVLwbzVW21qQlWbPbBDXZhYvrDCxlGdPXKHt2eAdn+beHJRWrBPcENOTDS5n1V/vjg0YXSKIFNAaLY/tJ+YYm5fwruOr4eVb1ZHgbeVdaFRx3zBM5c7Rmm03KJdtqSyYJq9fVaDOnRqypytSl1nhqBysYVU3+fTOpCwTshSXbmeMqSJj4Mfo6M+dIl9hsRshJ5eUHKaYplKYEW6U6RVh3d4x08tbjZXflPNXS4ulKTTclTdxKZ/gm+ndMGQPLSqp7dywtByb1J/XUiI06R0PaCwUj1AiGLR5UFXgYFSzYUuzGZRsJmdniabJcEkrIvchoaFcqkdqzuP2DRzlXtDvLllPKNIlX1LR5ubVI4500VmplitbDDKK8GqY5s5rlsixqFx0F3FyjPZUkOUtCakcyoenjC0R2hQq0k4h9JlnsitSiTRv3vAbntWd20+osdY2lIrfZBvi0+qy481k26WPVG9rIxeTKlaaZ00t4duPstFcY06kTazf6AiYVzBKM3NS0irQ17Fea6IKGhOX6O8XsF5KiO5rzxmuKxd00xez80/fZdpMYQw0YCZlqBmI5hJt7u7xzF8tbFgPaOYtqbMTodkiY3Mr7BdXLhUmUJAvCCfi0hRtlmxTkGBPovVfz2GNHJsmdCnWH7KQGplYE9NpUWhfMqjOEpFrT2FTWdrsGVpehRvHbkxZIKPrcyRV342fb6MUj16iaQ+oJ+ccXuNg9uIyaQ3dyi9OJZAVo+DnISoS4+IdKt+yD9EgaHPzY2cb72da0ScZNFr3GpHgoyPc2yNTMjFNTSxO5Rw0IazpH0uXGxMjmedYsCda7cajylVbz6gT3pjWrc0hbggjq1v1M9wQ72wjVhEgalyWltmm2k4TKiOuF5sYz2BxruNeyhENIp+c3nQ0J+Sf0aYtTEt0aWnozJhyNZ3Tj3IYJS2mhQuvaZ0Mle8d1ncYjAzhGuFxcAovUrRXEa+S66KcGLE5GhXl4yJeymsn5vBZV/CQYGng4CUujGqSm9etzPGu3yyWECEXjekfSFs0byYiKebfH8uu0hXjH2ktXezpFA8kWeMvT8uZchsIoN2u31hi4HPyF+UeqC3yElHZIB4zmfelipYoJdmcGCcYL2IRIFPjXpStU94W5yeWDAtW7CcqKqNWGNlS8vihapScnXNj1abPcpDg3GGcF0r1JO1wFFnmp2gSeI+opa9wWVayT1DxzPYWDg4apWzQj+2702sNjDIfGeRuUPQy5hns7V5iqGwd1JImy8prbOEjHukScigMHm1qniTYX49R0SOnnuqjc7ItaMwvLCwgb/mr3NzkzBArkVCkN5x0zJCZouYgWZXySm4pI4nNFaFvW9gt1LJJnd2jZ6RwBqjJINqppBXO1uCe1umdqigU1R0d1Zoi3iudkVLNsYmtrg/XKh/1V2ZUEaAd6eVw2tgWcIth5CcYpJNR0fMQR9TWDRDs9lefVxrVTJxXpeoj7xuYpqcO2Z7hVG/iYqUYD22xYNVplKaG5q+W5RGq2KCc05qk1ijv3ilj80vjb6Hp8QSS5HXoYk2Z1FcwHsWj4+aezZfjpSwS7Z/m69cYXzFKHzHhIFdaMvReEiQ1pF4joeCM1Sv3M0vm4CLq6NeU9VfXWRObp6Uqj23Yko9PLZromdmzmmiQDeGH3FWdWhYakcpooO4V8KwlcPGRYh/uy9lpZhXuZk4SbJmrlvIY126qnaGz21jpHKRa6uy2KNddEw+RsrHcXd5eLdzn8OqYYhGHqAxyoq2Tld9wiSdjGPArKXDwD1mp8ZaVuaQmWshsmLDzi9tbdqJfZ9DdpeJKnuiiqsmudG5kF9hO0Z3kXJnd6bHaC5A0mM/r3I9fGvYwJlwhYxkPLFAkiu3f7dIhj9t06WoHqGPdqWKRmt9oF7OT6RmmHlUQ5lokoGKhHhnRF9EQWayx1lJYo9Fs1tN3DGkko2zvCAopmw2UGecT1NsVLhlXuM3sKRLgCrKgZikJDHW4j1Qv1Noa1pwPrc1sSs4JIKvmby/vDuHh7TNY2Gvs1w9vcc2yYdVrbU7s7Ohb7etXbaCTKGbUVJwQnjhWZuLl8tDjmFmRD2rz3Rfo4hjm9BM2i430VPt9EJ2XDh/WqFyVEeGUt1J3lKLVM+nh9d3Zr1EZ3l+wDW+bKpWUXKEP7tyP7qJbj+JoIA6bsDZgLucLk5LhcIWmEmJUqJtooDkk7i9YMO6srkxv2NPk5WfRZGFiydLu8+Vol+BRriTR55Tzn6naCYqgFu4LJvLOrsvv3ePza9Gb0+FdUaCNUA2gJhnf1g9tWTMbKmkYYA/qZbLo2pENeFwXUaMw8WcZsVHpMeQO0+HhGN6177kS3NvX4wsbHF2P2/Fp3s5j0Vms263MpFx1kq/idfQRlM6yp8tqGaRsI9jxoCkLUtYZqSQ0NqORFAmQaigWz+SM3hwlLvEmTaLOpVhSrFHJZdMM25pV7BZnz3gi1hOn6NuO2mvp1iunpPec4iFvrvAnbRSInWYrqN80JUxXrDeoFvArDZXl6NVH0hrh9p+gFtvhHEp2UzenCmzRYilrb3KYG12UdxkO6l8a7TKSoLCynm1LIuL0yhUnD7Gq0ZHsM2kpUkvRc5EqIZSOWSPIjzLnJY2L1NqvpsyrKlBf4Jo13BMhUtLQ7uxq1WlQ5NC12zBKIyBUmw1mGGjMIeRMtnS1mFSgLgyUrqlpbcwUnctmYNQx703sV+3YmGCYm6iv6OHgsN0IJbAH46vd6q5em+JpJOKTWLGYWuSlsiwhWq6YIiUPWViItGafn19aEuOUb90fTnFmK14Rmp1VXZlQVLIUohvyENrgLFKaTBq25uSrVZ+ILB1gHDOhFXAOzOOJkaOlIxFaIuzU5XGIrGZbKKujSjHrTZKZG44ZaZAIlotKCSbw71cVL6FnzgpiMCfcFasdm6bb49dmypBi3Jis2uiU6uCjiIfPyiBw0g0f7S2f503VLi4oHBGNdAwXX5WRr93XYpVqYCXi5q7TbXURcUpL8dyLjpXbkOpec2ydaiee0djr75fvGeql3Q/bJ3CNzhMlr5kVWiEtqhNwzDEbD1HQmRr4X+sTTOvWoV+NFORQMqHS7dAqEhIhXSFbKdGwtGNyD84bZZUtHbXNl544s7Xh6q6l1xyw104RXhBuElfmjm4RE2LyEyHbG9GdxyuQJ8zjXXBmL9BRIp3kYxnTjqb0p9YfTLCji60OIlnuJCYU8mtpFOyzD/KWpmTnHphQmmaSrBGliuBoMxifY6zw8+QHjubrHjCdZak0E2sX5uhurTDnMddvMqF03KTtFvWM5rM1pNS1HtxZtMpQqSa4jJRRKGiYqXUxGambmO4bVSGUW+BLXdMe1dbkdGGnWvlNzytc8OSwio8j4OloLucM7c+wVRwUUBbVcnHsYCfUExxNoHQmMSDQ5xkn5hNoV7afYR8bWTDZkFvQXbbeMWON2yuc7pXdU67Zs1UL5WvbaxHi3k3i4KURpzRdb1unEuouNSzqThDsF5tfW9xs09+r5WwR1lRJMFYfIM4sz41oJI/q6bKo38sLrS4eLHAhYSpcs/AknJwO1Q+cjXHRXbKxIxuYa0t2C8us4dAQYPWmVDCiMt/qb7RlEnBRpmrmGvghpNljsRYTKWwc0RH1JKYqM23RZ5fkbKfd4F1qDqeOD2XZcFegd9uuF+Td2eAaz3NkkOov5pseYdhfaTXXGAjqsg37deYTnWvV43Sk305T6g6yzBDYqFTeHkgz6ZaZFuSP2/Zb7qxpTR3x4c3YTCnTL5p1a43XXOOyUWdrLFbc55AaUeUZcTGmRdwpTZwg5N1SzGYoBtgqHuZYz6/kNVAeEKMLXYonEesxm1eW6wpXXRxv4BHi1O8iH2SKD5WPo6OmJtYOVNyVKm1p7OuK7BA1WfKSkeai8xuWj0lx353F2F1w4k3Umdew6ZNei5OcEEtdG47OFOcxb46oGaqOCpYU76LQEgxvHVcMYBcXmVVeLbKlClBRHJHXMxygsBTR7bGnM9PlmHDtZ9izDJjdmFnVHSmapeby5BM24psMZDdWFI5gjPgeF6cw21NtVwwpWO9aLGVuJ92ooOqNIKfpIJEWktTOUvTVVU4ijSDPJqeh3Nnls9KTVJqYE+MkznWRIssMzYmzJmaXIPLzMaf33BvcWhxu1LHr7en0juNZUJw341KTmWLRJtXWrvPpn53NpNMXJtXpsZlwCyhZpjUiL2zicE1J5WtmVh4ySh2hSWNiCUkOSior9VuPW6zZy5jmsUYcTm8iVtAPdPKV6xtknU/MGUxhZWXZF8+qsV1z7Mt4z+C0KBIdKCbtSatjnlyeIedLJ5ZcDdhwHl4VW51t1PBiEsjnT4+P6o/Z8BTd2ZZl4hYPleDy4e7QkdOZH+DXjgbs3FNeVKPqoBKUa+AUXNFl9HhxJhda4JDuKmyq6IywoYusZiLakOSNIey3cWpgaE2iZlAxaZhRYngQy1ylG2nsECLzjSRmXJzsJ13rsOORqDDOTxSzJg0gqE1jbpKsNhBVLdmvKdaNY9Slj27TY9mmmKQWjuAdmXCVn5jsbp4daKY0T7RcGzMn5uwnqyOIYc1jIKSK6M8K2S+TsCtYV5yfanMwN9pT7OivJqDTlNzjrG6wrCXcsCjQ2ySq3pasjZWIbVgnZRUP4O/OoqXdaCDs7VkqmC/yVTJQ1NiwDrBkmWVdMKcxpGGPiuKh0VeYq6kWS+z06BaKHGJn8pJcYaH3r5fq0u7q9VjXXyyQZBfZrlHijezhaJAe1K4jr1mRqtTSodhWo6TUX6mlbessZRcTWxGkijQQ4hwrJNDrKRAkpWUlV7JTGuytJxePUZJbarXakIlncKDhnZHM6pXPbyCt6ONVK/SRY+OY1lhy4Whez+lWMBo0iGjtnyob71xpGA6tmw5eVC4qpA5hmyYZnkmt0bMkbqtc3C+f26WYTmxkEiolra0d0OAdZJ/Z4F7mchSgqw0nHLZQUVaZ4vYObPTakY4bry8w4s4sLqAWqI4yjrOLU3Xfl9oWbAo1ME1uZ0vjknOTHw/j0urnBpDq8pAlnSLg3uMY2+vWopGuI+edWwjNmbPaiGTqWRAvJpVqcxpNGbRKIuccXJ3iZwUgGlIelWYkoGihGVJio4uQUGudFWRb4dSUKeKT7DOqEKVTmG5PtKvO0E0Zh2MrqBpz4tpRIU3Y9Q12ZOsVM4ky0u+UnyPxeCuX2tJSreDKnjEsXiLVouN2JXMd8GDpK1cozQ0V9WGuVB2jzUacKCBHWsapo/OklNCIVeHTqNLRph1qIo4gj19hDykPmgbtT1SJXOrI58mvX9ZI1MzYMU+pHyIiF7FvWAngp69mmdobFdmozfNcC1NdICnR3aRt28zl4tEWW4/Okp6NaA5qXauj7R3Y8Z5ebp2VDIzikpghYRKpS9Cnnc/1akjXEh6cnSA0HotabGXpjo5tVWWdiU/cFm/ukrewbDbbIgq0cWYTbmFK7wmvsSvl1hrz6ytWmPDSY/SI2XEXJq9wqQqPk5MILtteDW3IHlXH7B1jJXGkpiOcUItJEJPVbV2WqozxSTIsUR6wcbUj5dph5B6yV61TnSap3tV1zeyJ1GVvMCmX3rGdsSYpHgdz1tWgVd1xLpJTLB1SLC5U1WZfrGsbnCrhcJZlJddYlePRlBRydddZi4wsT06Y0XWvE+5KJeCWIzFNzNjg8Y5Z59W0NGyRZq4fHefwKaN01vC4J1hZoN4WqawwW/Okn1bI7emnofT7btwaIyrasx0TZkybYrAFJhdX3tUSDIwXS3Tc5h5t02tPhEvhLtImd6ffz5Yh4w1j148fctevGZFxK6Tm2adPc5HmKetMCnAmqVX0ZWTVI+KYY5IUM+YlOTIjDdxUipZtVeqazGxS7xseqybxZqmN9Goi0vMsYJ8alp9OFxySxldoYh3QrxmhoqYRVxJVqS5jnGhkZ2PZ0/AoKKos5p/WVbPc3B+fa2DfWU8OMFrlqfDrRy/ljq+RLNdupeVcLRTpjF1zDbaSpBclms+sY3aZFzXfGacMTLPLLOejds0gES5RWo2bKbEsU12cU67Ild1vjK5itA0dHC1aHa4dcnMxkHDsrJSaaV3T65jH6U2lYxw31UqUVmGjl9WROC+mtNThWqiXNlQykRIiIF/WVehMkBxamE/W0ttjZexj2Z9xJ/Lb1PZk2aOh6qsTm9AQ1CUfDorz5+8uaOPWayeSkFukyyu3HVoc38isHQro4zAiWpTknEyz4hbP3VWdLqAhXZRPSpA0SHEOmdVvo56T3Aqh0NxlrZddI5kmH2bl0mwinTMnKuvyp+9L3tkoorqdlC8ZlaHhMubeH1FqG55eJ1IzYqYkIeAlTYys2AqeKMrIJNRx5s6VqHRjzx+cWVBp0xnakPBeH1KtliCM6vKYLWKZ5pCj4aiT5NRRHy+Z5yoPkpZWqHAh8lhY7d+kLGzgrC+RK+pSMum3mSV26GsmjSPc5uBiZFN0nS6fz9maNdEeZGyLMrXd2V+K16iHTWemXadVau9c2JUP8w5tjZFTda6xGRnNFRlbkO5ObKYS5dUwZ6jbnV4bCeyO4yzp81UeDmchIE6IZlkysSTqD1LlSWtXW7AfXy9aV6nF5u1RaxhM1Sfa5tIlVZF26CDfSGUrNxWYuFcsJ9jj4KrVVknlLCsfL9ufH1Fx28diY9HGLculZuIvmosO6N4iUptUEBHVFrPwHxfrX2ioC3Ofym4c5NzeKyCPL2VimoaqbaDwGWfszlUe8qmaog4LpNxvYE0qrhffspzb8SCX1rDnC+UfVSNkaJNspSpVWaPSahBiEo9nFsvQ5eGnLs+l2FTgEjIu5hZaDqbuKKpa0pijGHDKl2cUV+POSVjmag/cIKyWY92hT5h0cONTKEydE+xuq5DmLUhpETHp9Ct0shVQMe+schGcosdb81kJn6IOWEet7UqrUI2sbHHOTKiftLJfn59YGm+MEVWK8vJd5R3TWBCljLLgIBhY3eJmchxeZdQtVlaPIJH4EOrOq89s3mEabU0Rkh3P7uxXNSOd0dcm4vKOI+7wMpfT7U8Zd25Pk1RpYBbz2HSLWpoxEjas1teST6/xqWCLD3Fvi5sNl2hccuKaGhjllFvTGiIlV9hTJBIs4WvRcLLT3Gd0HtU0pOdZq5lTtKYYrScXSG0mUPRjbqNQb5NjpjCgmrDWTDTyjRKXYxmsieFTHG3WnbalnY4e4K8Q4Ocr5xWb3GemadKV4VCNeA+tFh+fqltXaw7MzmVoHZIPMqvenlmUrYsuC7NUWyUaqdDmK8Yp8i7IzCtvyLOv7CwrDR/MDTX5XebQ0N8pFuNwT+ZUmWeRFSrdaZgcMRqb6dMdKDKrc+ZJKyPjr7MR8t3OM+OvceQpJR85a62jlKndlLTP1hQpKk6VKkueq+gcTmQfG2/jri3lWYev5XDliNKQ9E9ZaBjw0tnvqIwqVWHwTSYLDhzX6RFtoapTrNKvG6ih3E5dbC1sTXaZEJYkM5PfqOorbVJRNKDgs17s4l+K2WAdNLUNMe0d49FwJdmWX05WLN9Xc+MQls+ec+Ot2VFuHiJSzm3u6eFYiG8mhokJCHHUj1Uenx9mzWhYqKPVU2PiIbFe4eEw24yKhiiszJkl3BWr23JL1O0b4doL73VPzOq08u1YkZJMFN3OluSlH+WNIN6NtgxM65FfH+OMUaXf11DlDtDSmlTz5C2Ss5+jGmIvSpAXX6nW4qURibNNZ5dS6uejcUxgoNSjKG005GUZzNwR3Ypln+OoDh+akPBiTeGKI2StX/alVKGM6d4Nk2Rl0vTX71lzliDwYd0YkAuVKhahrxZoDBvd5WLm0J6fkifslK7OK13K1FJwqjSeFdPlDgmmMNNu6avvGE9mTMycyyzhFWQkI8ytdm1aTOiNM1cUrtWsk6In8qbWGPOO7KotYB+uFqspUY5yE1beIlTUY/EVbBUlH9BaHN02LWkubaRpCNivW6bkqxiIdRwlW+LpGevk1Ra2EKFPleToIyLpY48hSily2qyro/SyqlQeVVeqTCvqJO+nKw6oW8kmnYzJKIyX2XFO9tqeLexzFZwL7xtNlq5qFo2zc4lpD2Ew0C6k7e5giOiW0yRw5Vvw46sfL48ZVeCeMeemmkogzDHpUo4bHVdiz1qOchXkGDbj0RKdHeaS8RknFjQT2+BxSNJdCt/k3+cKmMoqRYZxp1mhJpKkVvJGjg1MIKapacza5R1N4CGPcqhsyp/WDHTa9DMYNPFOY/Lj0vNjsOWwb+hukNkQpSni0LHlpFTpXufgsbWOrM1a3ZiuMViv7h6gMZQQNVkhm7BeoKXtragvXqgYEuUlJ26jMo0SHm/yrCjgKDLNIuXrTE8NVNtyLFPPMVy0b2ZjJZs74GlzaRFzIIlZVxltXIxyYRLxE6ggs6XM0d8t8hFWYSve5R5kJ9Vpa42X8Z2VHucXICivknAolI+x5SiYWwv3l5I1mXBsEaIw01eiz9wtUiKVow/L88hrWZ0R4hchohMXC9Dt0GKTT1vlZWZun/d2leYVVNTNlyu0kbUiotVVT+BuK/EhHPLgNB4j7hdm0K4czuiOcFgQoGAl1Iyx0U2gHq3SZyRXVdkrY2PtGCBscheOLk5USuKsat3lcR1hVpzrYqjJcVaSZk+kJ61QEmfUX55Z4GclImTOJmyWKuATuKMqG5OmV6br4zWhrJ+VknVYHeJZ1k2ctdHOMxlMmhjsZQuU8djua+kwURS1J5Uo3STZTg7Zo5XZKiZuM49kpOVtZiqOoE1SsOadppaLT2yM3q9OVkimYLYWa9gsmF1vVlVbph5eLtMq11Sk8pHkZPXcctvWYleVbRskJyGo4iGcWqSyCTRtsyvm5SvdMPUWzMuesDGO7qfoMNdi5CgO5KLrYnBxl21emmcr60bhl+ibW13dkenjqysQI6pKELVXFssoXMwsJhmmmk2yUmgPWQytUaMmw2rTBmFTkOUg6dKeMuviZd2uoXDhqxrsF9nW6a7G6s6QtQzmkrKfag5P1a5dKOUzrNMjyZvYlw7Sow1NpfLwXFeVpSNU7BZi1M/gFNBR7RDULsXrZG+LFy5ljWvuLGqk69PU6tbcXidJGpySLDTaZ3IUjhbn4WmYt+ZZXU5t1s6Omc+jbFstmR0mS/YdSxZO8ZfaXdyu8dHjERcwXlg17retUjQVXV+lW9AN9cfI4mXrEO4ZkxjgrOzUVPUPYl8M0ataUWqXtxEmc6GpK/hXi+VujXV2jjHWLsxn5maU2VtaX1UyLaLSbfEYrMsS1KApbq8Oy8enI1JaDBjMbrOo7GxrZ2IYEePcJLMlCZ8fr1lwo+9LldCtXRgo8GNYmWMOoNcVmlDZq6uMl5jSFWJiDKVfYCHSYipPlttvnRiQ5ZdPk1K1IhORLmxOak0zpBHPzdwfZPSMq3AZ0G5z6QshjxZt4BDfL/RV8ZmWmqTnECxQ7ZCKsiMVpExQIyEma+mi58yOY2XbG8vfMayuJwTrHNjZ6Imdm6sJs6isThFf857j5xYYuBtqq5nr62WunMzs7q9VaOOzM5mMaNwQZWHP7C9kWw4tlwuWJh/ml9MmjuKcIpCa8i0eJxsuLiyuMDFXIlpSG6BJcigPZomYkoxRKuwvGq0oMmiq3mg5nZyTTWwa4OwvTG3eTJTt4FTbCtYkWugcV8tVKtFSZefQoJyYjBLqHBq0idMRbp1WzSPhXCOfyJwUGs9xmPF6VJSdrzFqMl2uLaxnonOXVuZgbRjYHfEjcVyOsTInZx72SnZ1iTVOVG7bmGlr6Vzmi3XWD+APbw3dFacUWN0QU6Zkr5hwi13r1qYh1Cyb6jGmUfNYD9+hcgnpGJC2oZzcrSWfrYpQZVLXzXPrcxlaaebo32vvTvJSWJlQJxVSW1pgXtpw8B+g3xPZJvRjlM+dypHNTFqiX9cbq2wSUqIWHWFwY5ZgnbawXkwbDabwGK3iTq4Mai5fcpsobRYoB9bXl5xyY2pOE69uY9TXI26WTNoPMMmxXLJfC23iG+KY45SYFF/Uo+JwLVLUIhwkposa71VjImOxDZgHWOpOmmCbo9pXE97b75qxtpcR5NWQmNIu1IzZnU2bNN8f1RuRINdfENNj3yqLsuwcjdcSi1OLTqMgINdxmuxc7qgzkaUzH5zeELBOks1qi2oh2W6QKAsO60VZYlKuXDQb2yTl4yOWrK+0URkf8Qpc5qjWnlsQEpQX9JhP26PPCxAfC0vQ2xiW8W9opmzv3i8aGAvz9mtvtJicrRa0FOFYEYvwLi7rIBHWG1kaIJ8QnR6xoRKXqXDq2aNl1+kPHIzSFiiamZIct2VU7evklijV2NLVom8t2jduWazT8a8lSe80GJZX360y5ioJLqXhU6Wiccxx3pMlKB2sDiJunanp9WcMsKxr8+AX9eLVURFvYEcRVsjS32ZNplwkqBDiXiulU47bIOXxaJbkrhCilzLlm5l0T9dekDOhJRISGqdRWl4UGWqydKaT2djlGPcX3F0mbg0vl7VwEIxwnGvJ8VcWK/M3Gs7TCjAomt0bDNCVmt2fGCtZNRjPp63rYlF0o9mZdqt04B0Okk1WbUrs2t6xV2LkNI0Vq+JXkWwc3lQb6KzgWVnN8NWHaiHxneNdly8tDswnkeP1MdZrCSpx0dWhjWxKkvT0K9LnZDcXLGQnUB2O1xTR8ZvYJmZZKcqQyieaL58OFiqvj1Gy87IeE++pbJmkGu7mV2ybEd7q7W4a5a5RyNHkC9+kpa9hoieO5pwhoFNv7rjY5lMvH1P6G+oYbmZqsmYK2JAh5lThFK7fsXXa22ugpdMZ6+UqlR3xDWxHKi9dKuYWpNSv3/bz1DgpjysJ4xjvKLCi5V5Tm6gv6yCRzjSroBCdnk3P8Ztb2peVaVUiirSpDC6IkZYo15zKkzPfTBrdG3YOIOFV1yASGFuRYVBPGtner6ilZrINaxpxXKFJ3piuHtP2ks6U6tXSGKYfdOQTmS3g6hOtnhjTM9+YC2+VapIe6wte3Gex72HiFWLXFp4c4dZxk6jMYA1J5+WdYSWkmnSToBBJcZVQ1+dm1jSSoDDp0w7hqKFWsuMK0xmYEJjbj2tdaROiXqAQ4pbaqCj1GCqWGd7y2pUPDOd2pd4wVBVmUtXQkdKxCk6pGe5zTNEz13CtGgyrLlTs2otr7NqpYChtiTBKtdcxrhRYTYyXIeDY109h8JgiL+UzjRqgkSVnSNJXpOhnMfUwcyoRDRLojqmd8Z8cnjPSIpHmKiWfSjVXbqMiqfFfbc93bc/NH+ohFilYpgyoV07jnxecl/SiMRWsChHiChXmMWYaouDqla1gJRUhkCGOaW0aWC9eHvCdTk8qjM4yTCBSFSWgqqxtG+cM0eQ4J42aEOev7BLsm1rxI2+NX95MYMqOYu6nJOhgcazVE9Hza9quXmbUqDTujK6XlJAMqWOtZQ3rrdQTXSwSdxFo0w90Gk2OkJgunpsP9O8wodUYnBCb5FNialerDXZlox0lUaFbzdLFk1gan1So5B6dlTkV9lGo1+5Rka8tbhziFs0fGLNnHGouI8yymVXhyqtm9FnnoNjr1tjOG09aymUvZFeuIV7ZIN/iNCdjLTGYTPBtCs5FLF5OKfNrUkpOUZMdldXcmifN4duoW9XIVl6eLKsUdPQeU6OTXjJPESWyHmDm6o5s72trFPENrpEhrGkLoJsSaabq6KDU4h1kT10yCC/qlSBmDnOo41ybWXAvLqAM5tNTrWin32KRE5gwai/kyejRmREsb50tUZxconHUojYWJ1lc8ZuKIC3yc29c5cyRnyjsohInTUzbEk6XW+EXL1XNK+43DyOgKxjYplBcLyBr6G5ZpcrlkfNxE5DjTbBQMrTjMCSkSO2LlCyQjdferSBcCw/mduObH7OyDt7aoSRQD2lYlxqv3Gx1JpyYMFPiWnDgq1DRIirI5rJk0BFhpaROFCoNTmmmlFZu43DQtQyn7NCN6SgsC6JWl95pkN+x3lTq5AjsoM2mXuQNyjIhJWacW5NnzK3UlOYx1t2cieLtk+DszgrSYK9sqSwMG891YxvcYFmT36LQJ86d95AYY9hqoSzY0GMhnNCOkS5r2uwJL+LRZJ7lbuOz4PVf4JWpr+KpnGGV0dQo7VmzsAt1NCaz2o/xs5OTI1pu59uIlqVuWVtfolOk8SgandSa+ZIX6bIi52+lmZ+LWDHJ3BRsWVgTKq6MkzJfGlTsrl5c5RMiaxuJi5Xm104ys1t1T5f11GSozg5tMqDo9c5pStmwFC4xbdbr1qwUNVpRj9jOpdvXsKvNbrXY3RdYVY81Suvc86pNG9xbJ11jx+/wE9q46iOZDbCL144UbQ3ULlahJdXUjsscXUfqYRTSUCHQY5gXKiIR2StkKg7ZKW7Z0Uqt3d2TqpIsnomnlxAtaA5b2GQpHWFj8h9Zr8rbH5ruod2QH7EebRDf6S7vck3PTbRL2FirayOx9a2PHx+PLAkscg3nak0d0F9ZNxDh2mIhjo2raNNPHKCSC4lP5+WXLdkYGCB2aGXn2qiOKB/jaSrQEw1k2VQg2rKpl2yfK5BxsqbsTO9T2mDpUKync2+N8SkNGumsppMwmFvO5JsS3lBUWR4gCmZ3ladZKZRaUijwi5RiV2yhCucpplSYnJ4xM4ghJeVua93yDQv1mtPpWuqXcyffVS9UlpzpCm/gIS9YbmQSMRTUkWRpISbyedmxbayeoaVk3nUeLewga89PsKNs7fqlkSmkCSburYkUcNgloDIbJy6Y3swMTplnICzlINfYUTGSJpCripusXVlxsFvQxs/eKSRTG+vbp1cc2cxSZKUSa5ckIVeKqlQu7VJwDnLZcOGxlVqPeNm20gxZT+WsUuLR7aWmae9Uy6po6WQnsTAXj+CPYJ+xm5Hp01kI25tkl3IRZloIsMnnLw4sYNVLpWHYtbQfaYuzZ29ssfDwyeGPmSZtky6vTopmH+XOYaSlIifbq/NkGWuRKzZk0mGmK260DxDosapdTOxr0VxOt5MUcV1xElswZe3QY+vxSyNz3nEpZbKwS1Rws+7mNQoR3BHs6F73kV3cDzUkUiRna1JV5NVnl2LrGHMWHpudlXRt4J/Nq1VYXR0XqWecmRpL4Fh1W7Ei8N5ti2HtXU5ltuvMklBVnlQZDJMWDyxwzokeJWtVb05o0J9qYpvY5VyyGK6j5uz02hn1cezjiu8rHm6NTZIk4NsWEInyKBxxG+WJ1qosDd3iFa0sFK0YYt0yLq4QCGxfUon0n5UtVeDr2shmsOmeJxnjjh1nZlTKsl6X8U2Rsxxstc7crBgqV3BuipEV2nCipVIska1qr2NvZNFsZY5OK3Pakazr729X2RfeVslp4GNZK1mU6NQn5mWMadk4qihvWavmFBaPTtTqlZZg2Rv0DCGsaVLfz5GXV13UESGrlmgtJk5kbItxXXIRFI0iYmYs67At76sZziJpIM1lpNfz5e7eG51Tpw2XsvQvqVWJ6Qyap6CXNd8zJBmSrd6dkc03b6tp6JzRE6IU2uwv780Vc2MN79X1pm4rz9ufHlEVKtOokG7sKi7YE8UiFti2kKFPcJ+obJ+e3BHxbqwNV6+g3+5fsbCXUtONWFkp0dWmlRpSn+fOnxANY2df69IwWxdnH8pt7GkTOBV39yDRq6oWpZCL9xn3p8/cl5diZtzj3+dxEGsX42sdGm1TG4/sYFoZZrbe0hXhsuYummq0T9Kf4s3syFtMLRzw0SBVX+DNnzLWphYSIFZxnC/Rr6Uv7A8elF7qDBgTEKDQMqK2WGj1290TCV5o8CEscRKfXYysjOSXTduXEOPU6BjoVVyYKS5z7FIN29wwE2Mf6mhLK1KmM2HlrbTkrWit7KvUcuGQ4qLX16glWPJnztSqk/Lackqom+QXDc2eTBlrblQqi7XZT09V7yiOT2ExoNAiW1LcJtNoT1nNmSTzz17HzCRi3qfP3OCLKWxkaFF1L9DVD5df0WhWrdiT4K3cZOyZaSLl6ijoEkycGaiX1qslWGIPqWvgkgtU8hbyLi1j9liKLSToyI1vUU+Uo6cJkxDSKqGQE6GtjAym06PnnEzj51BY45skWS7jGyvgY5Cp5TDncZOQzRwUI22aY0ixDFEPoSL25BhbC9tJr+ObIVfY3NoZFdfsTCuWrU0bTTJwEtskXwhvruHr01NXIujaL8kKcrBXVc8iE+BdUy5hs7eMrFoJa9sRaOWVjEjrMCge5DHYEpPcLgrbjuKeGpZj3ifOYxBQj5/q8c4QEq+Y6qcml9Dc5y7nB2ca5qwu7yabjhvHm5SrLumWlHUT4iO0NN/QJeZaB6HqoW5UJ5qkk9bclC1fT+0yJcyaUfBTF7EQac7o5pNJHxXuUiAd9bTWmMzwnCkMStmXJe+aqksIncjVmo2l0DDydmQPr8knqvRl6isuXAbZLfaoW2QkW2zeFGmNzO6MsqyG3KwTJZneXKA15WIYlWliqA9nG+2D6iSMI86OmJLWbZfqzFQhcKPxzuv0IhATlqXz2x+bGaXdM62p6aDdbExN5XXWsm5Jz1sxY1tcZBvZEFEtV+HfTvHXlcjjzKrbddyftaXT8WqHYqWxizHvqNvjJe5KYo1x9JW0kVdOYLKwLJrar80OLOttY2AXF83wc0/Mrxbs21MVrZ1S5FYjZapumhcSKWZRKm3FEPEU9WKZMZphYUvxipxrMg+PyjQgcYqh6tHv0xSSTZfSKxldoGStLrOrHKXc8c/NdOvZq91NsgiPLqxujZ8endGXsquy3bFhk6iS1w7wXLBRsZ2jaZSY8fPnMBGu6Q1zcI+eoqFa0dSu2Phc5RebUWuuy11lpXVjXB2LXCQbZpcjUmLjFJywMU9bG6lS6JjNbUtM9tfkaNBP6qMoDBjoERQmi9sU4dll5W9jmQnzGw/mYgx12pItKOmly7Aubt+nE+sskDTyKTcTjhhYW18PnPEkJxpfpBHmyBhTEV8v5ChocxWlntaqmSFfUo6zYF+z2ugcL4oebeTTEtZK0M/P4xyYEZxXTG2vlBDdmacw7bJhCakvSmZqYycPXtMjrdwyTRCdcWRmMGqzKCemkE+yHKNc66KWUanWUePW485bn9UW0S4amm7NJsusHTPLEJij2zJM6qdzoWrq8NFwY2jQVmIKKE5p4ZuMKG0IMKUUI+8eTTTQ8WzW9ZdbFfaU1M5VN2ErSaUzsWCSIW8gkAqTh6Jb3nBPDGtRIuAMEiejK2SizpplY2SnUpfZjzNfY/CPLt6c68qmp9pnYHHSB6iUsNgnT9enZN5ykegZ8xlczAxj0BWfbCAhKt0XWl9q09wmqtiizqYZo5Pi8LTg1w+TdKBglu+N81NVrVaziyDrJl/iF1vSFmDgnnIPMZAOldBv4VGw0t8jax6NHBdqEK/v1bXXUSOkre5gjytj0euxLiNfVA4oWtJwou9qiVjMWeYttqMSYEyPE/jOV+ELK5OjzajSrokjl2mPr1pWzqdOXiJcKa8OoPbvohZPb9cRdTQjne2YN09QoVoUKNLr2xePb5NqUFL1mlWjuRltneFwEKUSM9d2E4923N7WMMwN9pVYd9Hq3BNWsTAeRU2sD84V6JRiYV9wLzRi1CEVKFCsJtMbYXQSoB13bBBvmpruYla1WycVV9sxdGEsJ+hbiOJmLlouJyAuZONVmyfUHd+YCkpqytWZHipO8ZkKFHPzatnt7xnrdeQXl15U6qhkW2TQ7VANXJJmr10NkBfzGBJdJVzY9VDcL+4KS4ZrcCUIph8mTO1tz1ym55Roap+cFbIjKqlmKqyllcvjkl3ljY1o8nXu0g4jcpcvEB/aa9Mx8mYNl2K0jY4OInLqXJjlpy/pHqDwL2bhzGBg4aKjbc9QK64dHMkqZ2ePXptgcvKl0yxm2eteii63l61lpEmUjCceCK2TWtfwFujtq6PcGplujZBj1OItLY/IIpbjrexom2XPTinLrQ1hj5OUryXHMg4yZ1AWc6dQECGvVMpmJtrRICmsGrOO9C3qEtjWNFaR1TPysfAmn9mWJumlmAqwYQbxonQUU2RiC25WMLMXI+xbVO2jct3QdaCkX+TOnFsXLJctjFDQoe1hyDCNYM6uTVxjq/MTy3Jjo+PuLu7nrujv4CQp9IwpU5VMXGPuj20KsyKoBW3RU40L8qMLMZVyKOAZGQnzdgtJ0iHvrJONVpZiVegSYmkWT5o3nXDah9CsGSKeoZMZLitRzqwgE5IyH2Ne4Kss6FP01RhqMo+ksVFzzNXqljPgpRhZ7aGjZWXeKMwzsjOXE3HTS9BMVmQKj/GkonBYI9bYalgSYiHUsEtToLTU902XYFcpWpbWEdKJm2BpruewzVuc3hU0HcnTDtbe75kWUy+v4xoUrHNo63avjhrQGVxfmlvLdd+R0LZUkA8zb80soJjoomt0X2N0Mdwaa9qmYSRWLg+QLwjg25musccXsBGwEwzuUJgxVWTpXfPyyxjh2i/k5scrGeqn4RLsks9XYNWP19ufGxqkG1+j0RjdrhrtlTXhYWBX0Ume3mjkYihV0en2EO3mq2Psj+tns01SZWwhCs0oXu7vFJ71DSJHrC1i8xIVIA9eGumnk+CMbt3rMsognRXyDbSk1hI43Hn29RLL0HDJ7VRdLawpLWcncZpUIa4Yp6xviK8crd5uLujjr4zhJbIqJm0YnxkTpS0k3s3j68/pY0zwrCFZ48iQLHKM0J1PGWiUDKFoyyiKpdPZa0uSJ6LFsm9lqttZV5jTUUtoVrBl5dcva+XGjTCr36Wn1I1z0uIqzmadtdPbKdlm6RfpX8cS22SO01nr4VnUrBaVoyf0lhjyIU7wsBZhRGOJ7KfiqmWb4F7RHl8pY1w0pZ0aKBPg5VZSrmszHfKk19MrESSq1yst62Gr3xijJuF84+dNslcRk1lUkDZ12lmhlPMzDhbs4RyZ3dyPKCTTbDOaXsUvWxanlutytlWNlFQK8i/1U7cXLZwXEJGmnQ5NpKNN5AvxIXTyVSWYzGaMmZiYlh7M5PPxl3BxcIyi5MYJcQ5z3BfrtqF3JIvtqDJPqu0hHpfR6xHQL7QL6/Oop2nmnUxzGeP1WRZTXTmy07WfVrOTD5g0jJhebCUUDpkw7OXXYu1R1ZnxbFcl6ijto0xOr5u0G1/R5JEbCE3kUQsajS4hK5NakjVOrqtoT1syzp6hnWmYVizR92ATqlDQCCSZIG2RjPCprtlGYoruX+6TYOuL3dea0G+nnVcfVgluDowinfBWnxIRmNrdr2IZWCzTXdZiMoqwkGRy15uv2gxjnSZkzSBx4eRVF1P40aBf418L12HyXymP6cndViTy2dnXsCbk14+xVNaHIJ6LBexr5NYe9FDso5nrW/Hixdlm4NcY1GLt6W0b5JWcYaglES4lV6G0aqQPoi2MqnKx7iOY2m5MkeoYKJHZ45cfWjUcSRomZ9OSGaveZOXRIlNedFjqXk5wbhPfGlaaGN+f3qojDU6MJedMotNWZxovIPJQ0U0jdqHuEybZqNxf7yxsri/QZqoOluPbWjGp0m/mS5xRodRQ6bA2XwymMowYmBEtEiBukpMu6y0H6iCmo4+eZ59UMZLes03iXRNcGNMSqOoNnQsVUmkiJxm1c56q31TpiZvj5Sgp2u9XI6AY2vaQjxHRJSxe1/H24+TNFjLfrGBoJtcL5ylpppyr8Red5N6hqZBxK/RoTWYf0JjF4SZailBdIyFpVlh1IcuYqcuP1i3biygpZq9XzFWYJo1USa3nXAgey9kwmx3gUpwQqtCRmlqV7hfJ5xkOz43QVdNOtJUODCqZa9fcHVPs4U2x0i+iip4TNu7mnuGppRsamK2fLNnhJJJcMc7ha6XQFWnlL6Alpa+PnNkj1PusEesaaCnXqtUuHhXtd3AJMM8R3adlketQy7LTboluTZhOHLWWJF0rZE3lqFOSrucqog6OYE3cridey9qxX+YX3bCgWWYRH5kvazPRzV9WniXd3BnWk1jXp9ltZHFrh95RDC9ujGoY1JhX4uhWMCDX5rCqiWTxcRdR22nS9UxNK5PPliDlIO9s06IQFSNxqtTkVZ5RcZesoTKYny1gavNcHuIemTGk2NlgH6Qtn5yJZDOgYiFh2Geu88k0WLCbLJMWp6QrrfCU9J2aGQ5Z8JlP87Zv2hDZsNvi1E+vrhSiT+ANEWesTa+smXHjz6JfMRzkotmgI1LhbU3zNVhcCyvR5lEmGeiY6+YuR2HdrosnttnRsmuVIW/rjnIw7iEuk2WrlHFwp9EsT6LP5w9a8vSR7Rp175BQymEz2a9gNGT0D4yLo+dfta3P1xMrYSCSl+CNJyLuDqWrtJPl4uWSDA3oInUSEuRq8GpGMMheqBTJD82rLbBd4eKUIQ1T8ZXk7FUWriTL8J/ntDXO6c7q9CszkVn2YDUpW5JknJKtU+WqTmep5lEt0lSQMkokZbRoby5Q7lXb59JbupuuHdjQoPKfMJSzbimPmORxGy4qlPQplKj0UdFiYvGRkm7QzOst31KPCPGqzaBRljUx9dF10uO3KQ2hm1rQUfVtmeSh0xwTE6vcd3Od6Bkt0rJnjp7M8dDeqlehTirOLG+NXK/VJolubzJyi+8yceLzbqyjTZgN4KluYS1o0N1lpGcV6CKkGhnl3JXZ3Klp5tKZ3NFXid2arKFOYxKvzfNor/KbooqQDjNWmYnuYeI1HhCHlfIW2VFqNlen6KtG0lux3fRNCy0MbjINCO8xCZ6c61EaStMd0uDjzSaeVMinlFWUVOHL7KvI6kpU5FLfZ+gy2mypkMvmYqbtjh2YWyvv8eng0J9lFmYsLJ8cCxGL9M3XjapeVFBj1pnMlVsiVJHpZ3K0jI1sXN/1HaHP2ebMnR+badORDTOjNJ0OqFonFWYca9sai2Cn2+txqEreaYlho+oajtLS25nJ0hwnHK6TWQvnUp3DLVipZ80aZhyN1w/sJGRTrVHyYDFK1GPnrnIQTM9k5uQTnLWayt9jIlhrM+lkiRIodBFbrFFR5O3Qqc+jZE/yVBU0nxTwXtnWbg+ho+1eSgme7p3apEsoGHL22VCq4JNnYutX4+FcFOoSH9gaH/awTZpWkt9rVF/KLVQi5R+YpZy0Fu1FS2mxZucypir0JY2KIWOm6uvy0s6bZ3RVITNaMJ8nU6HptmOipo/aFg5SEbfmlHNMkx4Wa6skWN5s2idF6mBbLG1srJRvDOuRIA8QZfcyjuEXZObaDmTxi9EVGyUs1062z8+fkaatIdSkFewOjXFnKE2LH7VV5/Ff5Kdu1BhtUpkhkxFjrZPdGl5h46XiJ0/ypmjwUQ9kK0zi7NZrLVtYl/H3DtsRyWSp5ectLWtKraMZNSfLX2rNll1ZTXIsYZxO5kwp52plJquXsApcl+0NFKrRIysGzOtLaBmgqy7u0yUn3StvnCUgDuWiCu1bG2QfDibV9KNW1ZpSN6Wm4oqd59MdFgz0pV0gmtSbLGCWF2Oy0toL49Tj4l7SH1xvUsVvqyRU1+HmI68qk+5xI25kj6TM7xx1Lih40zUnKt5zap5pWpCQkbS4o6+S4RcSK1GZSlPaIaNgMt0zmxJvS4uyya0L1LQSFPOz7kuzV2Ag1Sgq4guVjtzOYpXIMuBJU+hTjUni9fOqUBflapybqRRuYgxOFjJqMqhNUs9PddxUjpxalg9LG6K0cE8WiOaV0zcv3CgwjPHmy/YSFSDfZ+K0pFrn0Rpmk+0nqx5hsWqfxGUcK/Ki1m4Yj2A3Y7JS2yOaFHQPtaJK5OBP1E+oDiQnYDJ3SmjzC10SXSRYdcuWrabOXGioUyEikO/mEF8hK6gPnJ/Q2+OqZhOynmBkJmjvDd1xVqDrFdjv7ONg3lchG5joIOAu6+JTYGTnZZ+jiGQz7pPODDcPM5uVK1vTYxHnjVXhnqm2VV93HRSiVhKi5srn3iLgtZYUq1Ya2uPVb7NUXyOg3BGuWw0h7Z9JUhCibaYnzk8Z2tyh2VpWnCoY6NePCqfSYKElzC6KMGCY8FbsogtY1ikgyK8zqatqYY2drhfrZR+RpJ7U0iIXtKWr2yix0qMcKJBe5aDsZGr3EuKcXWERqy8dJTLQTXGZLmKc56abF5YWd0/z17CvJR1HlK/ldRtP7HQRbe7bmZMYpFHsMeKTKxfK2DBepRuXDB80a60sEmzoEgyZ4zDPT9tY8Sge1wekW3aUpPEs9AvQ3i80Ie2v1arzT5uQkvcdH5rIMR+uDc36dliO7tinDdGpmue3EtUd3FfeyqBfyFXy6ZNx8yvNnW2KbdOZsnOZmFa4mzYac1QorfKYkvFJXGOpJZ1ab7OMKJeYNlZjaB0aW7GoYk3a2bJXaoig4FexJ1SP8u5yXY5pZthzp8j1rJVtEqrM0ueTr1mdpxfyTNreYOjPSeKP7U5wx2jyyZsP6BujCw8g7FDcopPTZqjbzergn1uNqGphDCMsaZFkjmHdbjWVNzBOHyuPZXYeT55SoaJPsG/zrgySXksdFlmSCpNU5rRMWuWlEmIX02jalx7ULRUqVRBOc54jTB31W2aV1icbTkxQltRzjrRcbMxvypItcpljLmnV14/to6gS3RSV3+seW60sEpAO4zM1q12oXY6LcdPtS1wnHCOxEFMTbaQbcisOo+UUK4x2Hk3mlFgxLGxKCNIcFutQEq2gajSkDp2b5rLtql7S1PDzzcrwW1UyrNemaGttZxBjbKcdjJnWcOnVVuB1z7Pu6KVbMCyzVVrjJU3tMVAzipVn01yVHJRtD1kVcbOPHaMJJ1ZemJNlyi5graUEnRUfdWmxLpMaZfCIH+9nHhBjdQ31U9pwHemQ9BWrnKWyHQzq897bZFnbqpHybZoGWSjPIF3MHRZyc4tkSxvk5Wol4BzST4nmWGpNrtbKy1Yu34+alxPlF9qzHWmYR5oadGWV42Pdjk0uq2xMN5JbFfahay6n5RZvJ7Hxn5JVz2Mjp59nZR1b15+Q95KgTKZtrUyO7K3hWnGSB2lYxZ8RJHWVE5a2Z+HTchsHYeSm8MvO67FiJdsh8tq0Wtyyd0viz5DdY59N6JCZdqGgTwzs3tmO35RmYh5ip+0eY2tuVqtMFq5dnm9smdZwDLHvE7QpT47rZI81II9e4A3TpGPm7jAMkNNlom5T1lRQWx4QX4tlyej1ZeNsHiFlbx8fKpFUC9U3NmC1zpfzz9hw3i3foqThadlfmyWQ39wjpYxjbq+O0WWk8WFSz+F5X9FY4R+oqIzkzmXiSNxPshNzm1sU5+Od6eD3dZFO7OhZViyXzjR3Emgr1mdWIZT42Gfq3FAdUlpzKC5v7Rxfb3dSr6IuMItSjgto7SQiEjDVZ25brnjZ+JPzGaPfZQ5r1hjhFIaOtGen2S4kJ+UI183Qq+RQ5autlFmm6MzdFXBjpeDIc1aNTatMlZidjxnt8HNHVZJnmfJjkSLv7BuXMGsTUuJWkaolXe5jyeLmqEkeG5KKW+Lnx69pE1Bk7Oownmdm1I30WmNbz6Rl3TAsW5Ru0njj7lffFJ5u087un+2a6F8Mq63NosvdrKqS32mnGtbqnNBt0iyiWOCrljBlLlaexuus5CYYl0zckJsbGenHrItyTeReoWkRkGXmcFvS4DWs59NOTiUTlWrS8lwibzGfi2foU6LbIRJwldyhnfHXG7FZp7YRa/JTNiXX3bEc7arusu3aW5KrDWMVUOhaCYiqaFIvHQwk4iogm+RbUp+n1LZmaVgraSmLm6EUK+zMrGsrjFJvJrcRn9Xv7l/SxwVq1uNdLu5UpOBKNeXr+VFjX+mzm9LpUBV1ke1NTy4XFLhO6djk7XAoyKL2lzHPYeIV0s+4EhlgdOiVbdLKK0crcM1Ma7abtBhbslJx2OpU8VjqZYuMVWCd5ZRgbdtflN3X4I3Jye3ZqrWsj5uTpG/hKfi17mqrVMkh3mhdaJ9V9ufvj5EK6/CgyY2SEfWWXzO3UVPno5OZDYyM2HQcdZdz4ZSp0ofc6COJoNkLkQybKxLhkWbX1HDxatBomxfe6RRW4u+VNyiSU43xVe2LYxT1CqtpoqfW45bZ9e/e8dmRnJwLb4gectBL8G9WntyQXdEiJ8jf5dOtdE6ZryJWIfNHSiQxJg7VH8veyPIGqlDfGvbx5fktcaOxyR+v2+llMhUnpdaGEbHLZ+Dd4Qhd0PDzEBYb+JFQ8CFh0BLbm9BctZAtVBGQEyPYJKtgVFyP0NZIcfIuSCd2sq6hJCVppSjuHNvbZiqY1zAd3mejVUihbGvOGrDuUNeMVCv1j5IzS/GL7KZo5JeQFCRvVR2YrQ6iinM34Q7m55Romk4RleEPjWdSNRYQVAtfCymRag61a1XxTNeZ0c9dI1lu01jn0LDprSaRjLjWcVck6hLt9KNqLOJoZjR0LE9Rz1xYCDCm7xATHfBojOIc7VaV8I2MZKvcDtqn4l5bbx6f0udqKvFijhBkGF3nm7Wji1uL85Rck1Pha9qLUEulLqYnpGhYZ1Ppd5DmTBFumawr0xA01Wjee4/7WGMRIqmbnWTiSuCkZdDmGFcTlhCflSXOUo8iXXBq8R6lXB/q7OrYzGRlGmGqmbHJJS1u7uSZCuNU47PJmuVej2s0VfM0R5nLbN9U3Nsf1F2elRNLVyzJNZKvmdLV5x4ZnZbk0ebc5c622ZjM53XfseuvaaQd4F5ph2/R1+dPzidOWGHe5EjxC+LoLvMNaC7qX8qgzalfUSbsLTJZTI3f9CSnHKSTldaNnpZOKc9ctmVtJhdaZN/KdRXOYOeO7J7Pae4KMJFnEBxuzZ0hKR5HFwUfZesnYd5n8KdLGmqgVFlOS5dZGIokX1sgcI+hKC7rGLCvoC0qsgqQoA3PrSow1G5nV5PLDmwb5iMgDzDMzand3FNpVGGSJDci4SmfbNFUIfPK35blYJ6X5s5SDTJr127YHA6tZY/MJi0NRidH8JSi6eJj0XFupyt4GKFqUaruro8dWS/5GZnWstWTVarnTJozD8/hNeooXOiPn9dn0ZGtH+QTsqrj8RyXp9/PlvYXXTHhnwy2kA0xLvQnn1tlGG0QZpmSVuIXdZbQkdUXUpfrFOyOmyiYsHEqImjQjN+g30rU2m/czCSo8u+tYWgU5JmjeCmQ4hMXjuBpEjLhYE5XF6hW9xjXzrHy1RMfER5ycllUbKIVK27mUA3NjXp37BpdXhuq1y/sHSZP79db5k4ondQa0c0kzp1j1pOtGm9qLtmcjvXeMC/pFaJhGcqqostZ7e/VmWOq5oyoWtqqYM2xjuxZK9TUYUiJ7+Ov7qBSWApPTlixp20d6VUYq2GkW2LMMVdpYq7tJpCVHiVZK2/rrpMPKvNmdGN2j5fKiRMS72sXEZRWpKJh6t1jbNl07lZe76hyJjGuJlYYUdtRoBsUKNjYKyAmihIgDSaVUXPu6k9xzKAvWBGpS6dkmvacIEzKbiqYWVrpIlMv0dxf7PJmjZ7Sr59r6k7rmCpipNwrJ7FZ9FlQsWaNtZuuLtbxDGdf9Z+enHVnrM1z5lMQ8CFeL+qnJJhQX2kJ0kpkMytMzB5xWu3qog+W7uOU0c2jbiyc15Dld+mb1qCWoWYPEuYUmeDb6+ecKQ0oyvPWJBKyzhMQahnjKalwaIzlMi5o69cYnl8fV6Tk8M0niuHgLaHaaxNnlGhspWVXX5uhN6ZxX27RpaySWpWbMHVUmg0zb6ayT3cdsaZ3UtYTzZQTWR2zUYll09pQtFHSDA8YU5ZRJuAW1ZJ3Z9ul4tqcHUpctKgRDE1o9yOXGdZX3V8U1OHujlvYaNRmZTah0V2WYE8lq80m0rbgmfiSkOhyIxLtKqFrJRvWjVfpVJWojjqSDTfpVnEfcCkrjdVWsrCr52sTrgtH2lwM6lni0xXoYbPcaB0mVHSU5GuvZCjrWe4a5ZKuGioV1yXZEvNIWZSlSGQm7AoPk+GoVy5eLBIhIOtrZLKckmTM8JYe3dxZa5tfkI+Yi3P0ZgajKRszaNehtd0wJBVx6B0f4SrWaBdxnrJt0lTfMJsw2aAh2ndMYQvzmStRkfWxjiEu5c6x3VyrkSwfGyuWGCnnD2xaFU813bIamtgT3em05I5x4a/gcuyYEtZR59/bFHBzJ6XrUfBSXcs2HR1Wnc/uWueQjWbpEKDirywYLPGT03PQcB4m25ut2mSa8OVjYLEWEFvsUWjbVStSEOI1EFe4DF9klVB1TKOUIw7fUlrSq2uoJBwnDGhzFw+cDd9eLHQiCx5eHLHnHuygM+g3lOPZG+KYrhV2VaVimVzbB+dsGk0f5XUxEU0s3k5v3G4Yl/OSILIoHBSiY8ybifCqXmAwLFEVG+JT5ZFe8d3LWZtiTpuTbt3h0abjFI3YItatZBAkJiGmo1fY3V5s4aFkYh+PkhXSnfeRH3It5xGlKpWiqJSmEmTkYBlOr1kklbNQEK5pG3aaWaFfVLOhnZWNVhkLb7PfT2NwjiDmmx7lseyp17ZYDt3v6g1p1SFk2lAe1U80jVNm4M3s5yfP0Cu3IZeNr1sM62i0DVInpWwaC8ybMo9YHKFiSe/NpZzMYZ3xx5KkIW7cmTFikNcl3JuqJBkw3smcniYwXdot6SDkrU2dUWJnbmxuISHisiHokR5fNWLZz50molJWLmdpFgo1HjRObjJzLZnK0VZN4DjMJtgRrquoTbKpH5XkkJgWXRVycoyX8vKQIORLWnEdn9PcFw+fdBEajYrp8dEWK7Kf4zAWqOAhrRGwyybOSRQhYdAYEfFQEhZ1U5BbKe5UEnXMHaajjxguKt2T5WQUZ3CgDxuU3lAioQ/qcCeun2fzLSDIoY6k9S2xVWsl7grs6tKTtZhl4ONbxo4tE0/vM8mQGxJlEN4oqVWTlS8T0S2IYBlUi42y4BQ3024iFKJS4mLbkG7VmC1IZfIe76TOWG+IL3NtEbJXoeyznpPpbhUXThJ03tWSppb3T2yvZK3qVulWru1cYqbr6U6Hbyuh2Q4zpeqUE5tkzGIgkI33tFi1rIxY6+CXJ7bNdYrilZhctODWZQ3d36nZHuSh7iSZ0ZGnmp83nVxuC05xaKGa7MxczyG2sy9P2OAhJu+yGFpZHbJfcle47RgoKTQg1iDh7OMdYSs51ZPbpwxa3t1ynKSoqShNICyvHajim5DuK2vXqAcqmNuzH9kNZ00SUqWoDnVja54j0cxnMuQgjo4xUxOgameRspGxJaGz5BPhTNUqlfJUS6DizuNxnhQ0YSHuS3WJsSAr0+Nvo5yTIeyQHwptsKqkL1qX0FkQXVfgEMrYFO3J9WYfp8suTy6oiXCMVo2bUCUzYsifHdyfp97MGd9sIshSJtMfpo1zbtvqqGzQq1RxbJbNXxzV5c4cU2GGodDxZCDIJs9v55dWJVgiFTSUjSCM2g4j0HMJr5GxFa4OrJIezA+vntDzlTCsj+exMR8lEyjIGhhaY2CQdZddLNqqGqrSb6inqIUpTNlh80seXqtqK4sc6aFg5OjmVErW1GDV8q+wHBV14Kczo65ozgqZmAyfEvVyUvNVJO8aH0xzYVVuT5YXYCJdkZxuK28OsBut22JboZQOUI0aZGLTX94ysWLvDyav0jCUjWRwzB2hcdAK7iuaI9+2ktURJnEc5wrg156obRLPGa6JayCJ6F2i2E+bkduQGA0xzFgkrRjcp3Ku2FhX11+HxK7qH1eS32DQ08vnKaKWVjJfc5McpDRj2Rs0mizYLuy5mxifTSRtouBT1s9a65nxXKvUJR1sItGO32kPFZMXZM1iLx/KMzPXmlOvGddfH2KRYSlrrN+Vyumh6xfRrVZqWs/p85QtK15kHRdZ3mehLkwMn6qS6qvJJahzZQ4OE5ga3NztUi5OI1Ykqt2oXK9HbW5J1a2e9kxt1x6s35/NkOdsIypdbCCV0vR0aNspsqGPFXUkzVmUXuxSnNvsos8NYJtdIOT0dpWoTPVa8xta7pE1YNVlFZij2rPatahXrhcbbO2RYuyMbncgbxI5Ea0XbLMoX2bpT1UdpDMY21/qXg5ictiWsxm1s2ntRpgwGF5yEpOTaKfrrG2pTKnLdc1YjNtX9k4S4t0K6HLqHWPnZWskpedmWqdRF1WyUg6NM+poDZepomkdoeNsoYrro14r4A3ktWEMTh3kji7mkkpTnC6p0K8lEKhRY2bZsRloX5YkqMpp01xzqWmQih4siQ4SJA/P3Y7NthlqDhPUrisSnYVem7TOOZpX820rzhpj+9qTqw9UZYqpn9zucPEc3/SiypYzlHMPlhcYMU/R2JVobnJaXWGpn14p2x7e1xi3U9qU3iDNGCeoXFMpJSzokFBq460JcKGrH5Xmr5ztbyyqDlteriBtJUXx0+xS87CgiG4s8LFe4s3nrxMRkctvbw22pEriHxkQZdGyiE5ZIqbLXk7W148yTiZsIixv1BEw06BH1XGwEt9Qzu6a3VOYqbBjc3Qb0OwQzfKLk9/SDo/mMJ5MEBih0toa4SQ3EZkJmzZqL6dZTjKyrdDkq6jY29tvF2WgHCVd0m3MMpER0Av3n3V1r+Eq8Q1pnuavUdWl55LrXxRroVnuVF0ukmrY01YulK6iYlcO743KS3MXqovvD9yL148z54tmbBhs5W8gVjPqkdRlnFGRTs2gUllgksvgdreYFWvkWtNLX1jmXE7gRsiuXxdj8hhg4ZKc3p0qnNDVlhnRc1BuWyaI4imbMZdVcSMQMFjaJhlwEdvPJTDIZfCVFebvaCSqYw7b3FEScJin3GXllM6hMPhPZu/ukwmrXg2OZdPL6GTi7svnywxyEx9UppykEYobY5YcYeKqb6lYGK82I/TeZ9iRXtpmjbQjixSapHGWaJrc6CInCZbbroioDqeyS1gbYJ9u2eEf7lQg5x2T9yZ2DdKkrU8X9NlyUujbJSJaaJFm2o0irBMusdObdxZu5/RfK12bIR4rL7TYVqSZruPT4lcUnx0wMCcsULCf3YndHrRN7xJMlNDw3uQjkjcpoMsVTrGekTJu4ZocStJzqanq499MVKANqKBYFhLsG2ObiWjh3CWWE2cmmDCgie5VcByxog6YbEsQFdQRU10kjOGuHy+lqBQqGO5dMmFQbBXybllQKw+1ERdToOaTWQtr7BzYsJMuGxNcL2vpDKaMT1tnMK1RMq2f0VBz2Mkxn6OyJGghJcrxyyub4iOqIVSP3yKUHUnIUrOS62fS4pQPZvJq8qfbDlufLuJ1aJVPCQir26SsYc60DGCy6qUX8c6WV2BOLtJpK1Iva9fV78bQ7w10pebe3SaTYzJRXWqWbllvUtAskWaU5pyPN0ya5WrLJeVQoFD17lTwrhTqplOt5vGhWuMlojQqXSFP16IbSW/P3hE2F/hT2ZZsmWAg3o4b6RsxqhlF5yMVZyKM41cJseqNjRbNpuSNI3ON43dQVNkPVqbiz24sb+siy16qbO2qq0+U72SlIqufCl8s5HCt8uTfW9AzrnNkpihpm1d1D5/HHKkscuMu6Y2TmkjzKAoejVWzW+z16pCk0jC2kDPV3dwLbN/RJ+SN8OGlpGQfVhKpKVsnkFM3W3X0kw5VlHZPXtlpaRo2jCkREXH0F5cQ6BUlLlBqm85kX19yE4zQmLQeXSXZqB2XKaOyGmusEN4yrOqdn3bOFpAaqlWXbAhY5qPRb9Vn31fp2Kpb8hfVok9dZaMocaONaZ+PNJEg3w5PWl0jK5QwHVeb8iUJpnLZSBxKmjSIzBiwqicV5p1g5xAmiO0sG52kIe704k01slDsH6DinuLqZiUK4GGM0ynSjR/Znle0EJum9XRKK+ajsKuGItnjLhCLHJ2kaGii201RsTSKV6en4hNxqLvjIRrRnGUmHdzKICTQ5uULEetgDmGbpnFnqe/voKpWBiqzqZezkdWgEHINL9xrH49t3ZzXY2zpy6kOC5zlX+IjZSOljdd14bPIU1KlmUgaMQZY6eAtlrIsFqtOW1deWmm1ErePT2fasaki7OOV2eiQNtFbte0gJA/rIZzSy6CqUY2g6VeQUZjvck6QH4tJKm1jHvUe8OOfV5CV37AOdl6M0CratSA12gauC5HPbWoQCi7fBuet4yioMU9PKmFvKRZlsqNidGsfcssOzNfhrGezCJtyolnWkHKsa2TzF2EQa52mZjRdI5kZ1i5ll3NSEl3cGXRfX2ekk6smaCwQEnYiXxaQVlSW36LrDq7f906PmCdjJyLWFx5ibKHJbuTwNRbqUM7fFPXy2hyVVQ0gTypQVTYnzKUKsF0sX2XknVnYagsp0tcuGGScE+adZepv6MijrOas884OzlAcklrbkhDfVZizJiKRpZXdmpdRcROkqNLfLeZaLxP85TIQGu6NFkzqY5RkcK9VMZ/HlSkdcsxrmM4TaCBsVpJU5ia0LRPKnrJhG7F0GKHdGG5gas7ZF7RQL8ypX7CIb7Gl8nC0GlmzYR1LL6zuyRgsJi/KJpcjHfRn07JiltZT4OrzXWPkaivXaqVhqW6VsJqyIDFk1eNW06pknZDaouQeHqAvG+LQKh3fIKASLlne6CSkIOFv3iqfHw8LUU1Q22cG34zVLo/HsjCoSphauBDcItoknVikVPJqTGenypLuZx1ZEmtn1xBWT2ewcs3cJw9PLCpgrehhL+/rEWYuDDXVbOgnqIbqiR9mpulVW5gsss+PqaCV2CZSHdkbq0/3dZDiJvRpY0qy2Rwpr5nTzyBs82JSam1Tq4wcZpHNsWNik9Z1thLVp6+p2+UPGsqxkm1w7ytxaR+QE1Zi2+2WYqdM5bEHMJJa0xleDs4dIVrzsEatMbBhRVMd7AxkpRUiXxzVzkmfp5KpDCVSJJ9K3E5NcZqtqBPWWC+i3hrrDiwmDWVSTQ4edVIxl7UkLfA0Go22VGjaGVIT1LmPqNCqpdAdLysRVJBfTbTNKqTMM+TSkVywOHRVq9Kin2CvNCKo5B9VMFCcGjDs2KOiVTFqJmGSVBjtmQzvn8aynayWVaaU1TRUFZ7c3RehsoxUzKkuqutq2GRgWZms3hjXHa5U39aV3M9WYRhZYFVSWhPfIVZPj/IQas5tUyDrb6PyWE4gJ8vw7B5LZJGUHatwsvDjDNvdL6iskG9OI2oODtVxplRMx+tmmNLOJCfYH6JepTHIyZ7Vzk2mrDKNNaWoDezfb2pa6RXPm1RRo5TiiSGmBlflccuboaSwhcQroIlnJTKtbJKZ2A3rm91PMcem5SCvpCZ0WYvMUZSscCaUc+bQY8ou4i9hJGsJim7uyYjrXs5kUG+MpvNxzwsjlOhb4rErleFmSG4tbQ8u7FpRbPQcalaz5SkLcKMhVpVsCdWe2Ze02tph5KrRhyalK2hilONdmVrm6i3qrR4WjhjT9enm1CCPoOOSrUvrB/Hhi6EZatez8N4b5wyZ2DKok/J2WSJm6XFOzeri5BrtHdPebV/lmFTfGXGpY2aQn5XoMV2NZ6/MS2IVrBvs1Peg59igTSX0Uo0ZJF5JlS6tCXITM10V0a4W2TJLzk+uprFU4EkJK5CYp48e7xeyj1FQ1uUz3p5nK2FcmJg0H3OJ7OIM9hCWDxMZVZPnLsxw2SWxNuagrg1jWV4lrBCNX6g2ItjRrNxvMk/PlRsvH+1fHdvWW0vP9RPx4+yQX5ks5pmZ2uXqF+qTDRioqKooGizM0FUQjF+PlGkjsXDRG42bspeebc4VWYnm7lyVpCcdkJIJIDLk660RErugo6JuLjClqV435Wtnp5svS2ulaV0kzKfqkxYQ6JH3UFiVG+hzlNVi0KqU0GCrUWckZxUJrHlz1dVeGNNN7OOrHudN2IphZqDcnScvXtbc7NOgmow05KQMaGXxKlSqYUiXZU8dY+OeGmOkVeJXoaTrJGYdEZdmkylVETBXS/IZIZRY0HB1FCZmKh9Vo8hfmoyrKBNLqFPhT+7yX2mRabHV5uyQak+oLaDhaEu0cQr1T6aW5elf8+9YGRBaLJVWaGmgGeXSTxcbz9aSq9vYz5a3yrUTpq9LFbCo8NLWEdaK2V2sG+5vaZ3uXNbubtmaFwhO5lpwcxCbpyt22GRyFhhXWEwqUlExp6KK0G4hYB6vzpFz8VzQqOIoTGBhrCUcSxOJ2esdZRfUozHa5a5VKqxJrhCh8OXa5O81spTL99FpHHWXIe/t181hpB3WJc2bpNOj2ExoY2bPYVpjVuXkaRRxi50QGi2j3sdmlWJjsnFz2alxKQ7P0CJ7UyEMjikY6+dNbdYqdK8J1ptUIi+UrNnOXmo1Cl6cU3RcmlLfF97MLSpkyYgrTMqaImtxbVrl5FKOqVNV1O+mjDSOHChUjJ1LTFyertTUM6E1ktWcE6KWqaElC9VsI9XtJpwocrndETE0cWIh6G1vKxkf2KBuC+3qa2Ny1HScl1rkLFbQ2V6SY2zw6p8X8I5rnhVmKo/s1s9zW7Jji+7d7utf3vccXSocn5ry5PNuVujg71+V2CtnqoeSE7Kn5ZvQbKgJFpstKxYzlV7b9iXPUx5MKlIOMFvTa2eUr8+MqJAfDh0j8hZrIF7sGx4XLMyN7FdRTRFqMxUu4ezibC+p4jJzDyp20RrMHSCz23ESzM/uUm7L5p5xly/rc65yM4fb8UzzHpwkWzHaY+Go5OXgrZfuU5fUG5XTE3FVirUOCV3obh8bDmkhnIwsWCqgo+0es8/g3N4T0CvXYpRnrxejEKAQ3m8Q8F+eUVdtSu6F35GYYVSlJtMo11YZZl0o3R8sHajRX9QlqdgdZTBnsYuyKJKsZ21dI5TKnKOonPNrI9BlTg5hpdHgoaquxs7WKCXbjR4T74tNoJvOl2MLoKhUk5HRbuEtH2FpqiQfDuAV3GeR7CZ1neQzLtcgrqKIK2p0NRtQS+xVoEqq6i5YatXwp2ikZPMQJsyg1tYpLyHbW66na+YhCt7e2Eia2hVXlO9K4qW0m6Rjy59RXawY2hGgpPOYEmSmH1tu4iTrsOzMUzPKD7BZkdHf3TWkEhuM5WnKcqok0kop7innrSdimRAh6GXbyZtuJi4ehCsfKZEm3Adi5+8UbSMQXlAeltMJrI0heReNVe1oSlMbsU12ym7W5+FNY9JVniLVMgkhK91ukiCkFOwPHJYfEBixI5EOGulpMhLdXyCP2vQU3Y6fSh1pKiRargtOo+wq7I/ozlDh8M5Sty+ay6OMcy8rzVvPJ3Hb6U9g7R0gYKykZHak3OjLp0pPb+9RT+GKGGywa3OhBmavrdPtYSwczI2sjMzdqiVjb8rbZUv1YrFl31MW0x/UW66N7Ewg0uAmjh7pmSavHwZo5ppsT3TI6VHPp60cH0blLZqS8SrT5a3KcCmrmlvPb4qpX813MJyi8N6nGagW1GUHbLAY9eiNT7lkbdHRE5/tr6WYHg0m53TQo4qrnBsQMBNq2bFiXasSW02q1cun32GXTS7NZA+fKzUx17SnkNXIp5jWH1SeEFocU1aWIo6Y5yMqVE4nbGcyryMt1SeSUq3qM2AuTXLNMawW0s4RNqNoKqaaEtPPGlNTU1KzpI1sK3CYdVbMp2XnMl0VdiPv2E2YTo2q8KYlqmMsMJUV23EhDzGYaVNpCuoczZiPqaFw1mZda6mLGOJlX5IYMdC1MtwQ2OkTr8/ZM6il32xMdJlTYZcsrMztaZzdWa+yal0xEzD1LtCOF7Mx5+xxJGMtYp8rWHgmXexcjBIHkefNXuubCqvfK9At6+cwlnAKHi1q8w9jVpfcHpHz1HFVrxng71rM6zFczfPsoJgcGJRfcBazcOxKMVHY9BQaneWbw6GtTapVM1fTVypgMVMk3leTGVY1EplrVyti5lybk1p0mYfpyQoQUuKSDWqiIykLUo6hIzX3LNFz4jLWHNHMsYjm7vNySeNdbQ7qFhex7lNbKdM1luclXdQg9Bkn4YslDGc0MCAY7Obw21ROILNQ1hiPHNIy2c/zIiEfnY6ZNVTvZRar7EdxsmSM4VSant/W5F7G6ozLMGuyMJvf8RWR5Zsl3KCd8h6kLylp8dPvkdXpFnEkznWUGuoebJSM7iZcluyjp+Sd0p9h4ygybRtRll4X7YydJ2LQ+VUy0ZlVa61liugdECqOjXSdo+mXjC8TnxGj358hkw8pU+mRnCzYjWRtYaxh4PAv1NpxGxRi7vQi2GokEi3yyNewyWynWx1uhqwPrdSzUjKRVnTYJbZUYmUY2eMo0a202CYVnSRlMtRO1txOrivj0pcLE3EhzNXaTNqq1jBxNWggh5zc2rWZcaFRZMqwkIowcV5VyuwwtO19FGGQ0I9G5mdlLC9ro+Qdzc/iWDCyW+mT9PIjLqDdZeBci9ddXJ6gUdyeUKAbYWbo7amkERaUIeVzKExb3lcZ8KSeCCW0FOI3b02uMN+qUbPPaprUZKMYcC9kohH0EczxOJEyqJoVtNqtYM/uqxNTbqdvItoYWeGXzJCr1lSOmG3obspfF6yq3Ny4m8sFn1BlZazWC2rpM14q2ynToZRe7t0R94oSXqxs4WnR0ZJ4KB1OnWdjIlfdq+owphctGrBRJBFsDc4m32tMog5MLVdU3PEmW0zyH55tTmqpm1SgNRSq1c4lsE+Pjeuaq9APIDKtKQggnrTIb/FRY08Wp/JlTybhj5mq0hTg3CQc3FFw36nObaBQbm9hDl1no1UMllhQqzFXb1RqFBubzU5QaJioMYdP2lWaEFxMM+8S3O6XC7GoDNgl52zVp5Pb4RGY6y/uXU+qkePT8CnL6JmSm23wtZZVYl8aKCEubRbXm3JlLZ1YtuUk02Wiqlbr2hffIhIttGxwW4+hpK/pH5uRmJcU4nTLSl4T6U9eI3Aoi6BXEZskDyuHZQukZOVeYM7QLKMqzTRKTe+x36mOWhQeHPhT4JBSDU1cYHTZd4wstGliLNMxx5Rk3U12peKWIZM0qloP6s/Z7JTnqQutV24H61LY1iZn4JiQH7GHprMSCQruF1AT/JDkWaPsrBiyWxX50uwXHKWLsfDil88JpJVyj8ukJrZeZSOj6hBZnfTjzw1KiGzT8cnlVCgPKY2pkKtM3MrVG6lUIp5OT6zP6mAfLyZd5usUMBjv5+gI2WGHcCORV12W2CbIawfz9c/YW55bnOwN1dflyyNjMGN2Hs5p3GTlJCyxiqIyVmdjY1CWoeujT6fd1Q0aMg2bVrBc17baLanL0c0rY2VzytpRHSukqTBSpl3rYZPkMC0n78hqYuYri3QOaS0b79+o7Nvt4Wegatqryy2SEzBIXJWkEo9rok/asNsQX/OfNCaqjbKZKdRnYnBIk5uNF+dhZdyOkDOP+C7e8NN1KtWmEimn0+KhqSslqRjbH3FclikQHTXxnC4Q3VxgsiwRK89SGWPpYghQKenKbRxZ62BsK2idVhdgqzQMS8gwJmVMK9/Uzk+uD9eZzOwoLu7hlN3dK1uVVBLVIB0Y4yhgHpLe8WOrKBBeGWFYE6iXUSSs16DPZPl4ofWdDWoYkfSz24wa17HdJ44hrczMbeHwn68n6t6tbYuvK2Vyo24QmWXta9QTiOIkGGRz2y2ri521EeFQI6SzU5KpMtmUKfBuZW5XDK1SaCaRG+KVUGiZ0DNq6ZgMDfbirRzXWpv1DFhW3GmxKFNsRhTzalpjqAwp1macIJ1vpC1giu5MIV3xYZ3s0O1xF1SUOQ8sVe4uX04TpqGkl9EWdFBVdFV1ZdTskLUez6kppOdfclXlSs+yU9slid0IqbCgaVZeJ5zYjeLwHQ+i5k3RHHAHb82rIM7W4RLd3KKShs7z7fBnGlgcm98wzaQjD7bWNp7XW9qnGecNbO7tp5GaLg0o8amYjk4nEo/LqaahneNqcx0wclYWUeNV2LVdDWY1zK5YK2iz5jBQZCIma87krVkRrlCjLBApVdvN2WKOGJkXVF2usGjfSo4v2RAKbvGK0+HLa2pg5K3VFpYpreSzS8/kjGpd7lFM27KS166VUB1yjB1e9NifHTPwEM0h5kyW5ZRcsAvW3u0HZVvzH7allcij6ScwxunZ8N3sarUYG49yNTEl7NjYVOYK4aXqZzGTJhWt42srqZAm4J1WWZSTzxoP8vIqTNexrxKXtwsm4ZTnmFOtUUxixmBn5SHFb2wVI2Id9AxV1LLLIunZIB2rzWfuo+0YkvLxah2RGZQPKyuca6kQpd5qUJy0sovNs+gp8E+WqpOL205mypvyFm+Q4U7N8O2OV3GNXh6xnaIp7zAXclrVKbrOUFceHofVpSuqp9kjqpb1cxAiXKPNJxDPF3BX9Y2moWvnrIsLoucUG1ys4y2QHLbZ15/SDRLmWl+eUaQS1aOia6x0jY50cJvuFKZcouyq3GnLyuQs3ctLEJ6sHBsvESUeZoxSXKv0LYsYzjIaC3QOjQ1P4xtOcS+pluLLHxakqqYbbaodcKTUbFzRmdxdn3TWM2dNkhc0SVwyjdKtYm0gbszllR2u3kqwCwwSFeVaOyHuXkxazBTwj02RjPPmCyAto8XbMQqVoZ7aDalZ0KPV2yIcdiYWLC6RmvDl2FLeoe3ubRZJLZaSjqMvj8tZDwzcFo6RmSxKaFwb3lsj2yzaNG7R7ys1Ht/OXyydb1SiLKoH3qRQrlgbhxToKDBzrtYZFTJORyOrNiIfFY8qJOwVjLBsGNOrTfHkH7Bi1VtxTlqiyh6t2+ysndB3qc52HZqgI0gO3h/WH5ue8QnfCWRfpdHbjVlqC2JQsVkckZ8Sjurh1wdxWbCpWW6vHSZOMu7Tco5SWOJfnJLe221d7yqzh+WgJDGY4aipLu0mIDF2HcoZ026R56znT1Gh3O4zXNEeIC6l1tviXgmdjo/qbtBgEpgmrOhlVKEXlmW0DaMmERESjyASYneVFPVizfMqJHAhoxwuppmNUV+ipqqjbEqK6NqltClRsZlSVBzSzdeP0ehY6x6fJYZtl17da0rYUtWsimmmEdcl0auSpGbR2221s1rg65AW8hBbjhWsYW3kDWhx28vNJbGrMRxs5Coc11aZ0qBRnnHMUCrHnqiZohRWqaV05qZyU47pZZLYq2LkSi9xkSDyUVlqkDZtDZ1briMbp91hpakPSY8UNFYj1qWdYRpYXVjk8Nvl3p/tmCeWVRNn584xXxZap8xjGeXsEKZmkBEjIvEVLaDtj1IkFdJPExRtrGwnVPNV3NC1YmVwEtPqact1ra+gmytSqfEh29wvH4shK5zyZhoKjhGTZucd89Nw2HEcNfETUNrULy0xc89Qa91S5p+cEuDV868TWOYhEqfvJCGyINhxVdJUchpLZp2b1fBPLzHqSUpu2TIOluiJ7W0QpalzlV/tWmRn6NdnMVia8GKuGtajlG8jDW6wk57NH3NOmzTtXeDu2fUd6+zq5JkgGbDO3pYSidLXj+ahVVhmEhph5hTk6NijJ3PQGtYhZykjEgZcT88ko1Pn2wzW3qdfbbkS6ZaZy3PPWuqgqNnhHStvitVN7M3qsM3SMxSMammhUOzmmAwg9Z3m36FsW3CV3tCYG4/YMvIvFCFt3EvNTKp2E17RIqffHpMuHbKi3/FRlHgQIw+NWxnsJ+nv4EsZyhIlZsclMJUnEmWQcF5ZbV3Nn1tVYPBYUV94OuKZHKpZR6Rn63CLKUupZVQrLJmXMk92LDOKzPEhkNsKWKRgFadRsdeqYzGZIxNbcO4yKddRn6TZlAnX8xzxmNAtHZl20GATaNpq21OVIA3WWaRZzyrN1aYRGeZTricimovf0KZ1zRtympKvII7hWi+wrt1x1l91b7PSaCNO9Szd1S0MLGIS1GJXtfEkXxxzqo6mYe8Jqy4ub10k9ax2y1wg9DDa5HTVczKuLXbyX6RZlFCw65biZCfqY/SyXiJaKk8sMYvayjQyp1nwRV1xat2h1ZfOaZxKsGnt7TOUY2Dsncnk6CyvEBPhrSScGOStcim04Ols8xipTLONJQ3QJGfODw3rpyjgDtPcVuEvLSkVFjJbcBGU5eIjsGURMptTI5JRVOXwWBJbVRaLbA1paOTqnkwRXjLTnxBQkJKkmK/NoS1KZufdpW8wZw7RDhqkZwPfKaSOqasoKfYzcWNrs4/Pz+ZuXCbHlJ0sZFVgDRkm5q4p3R6jnXKK8V8XlZmyMpC2nXInbY2dE7GPaVUflCQMT1OgX/HkJRHJsWcbTN/k41/z2eSzG2md8AuoJatNKF1jWi8uB6BkYMjxXWBVHdBZNiYNag4uGxINYC4SquIh1g23VacVWBXsmLT0pSsRHdTW3PTunOCwrWahYhuon+EjnOWZaxwYC/PsbOEp39Vkleko1K+x8GXHL+Fw0DKPItXa3i3s5h7n0Vb3rBNXpyCM4PcyYbGhHImfC9ZcG2Op2m2UCx2jYHPXY1UHatwKJXMooqvkSuMvU22t1+ZY5i/fyevkT+01+hQWp60ZpQuHbrPOENjRNVbXFdFp1uIhoU2vo+XY1XOyzCNZldvjaemPso5rmatu287VM5ow2mAbLyLbaDVzKYgS5Y+cEhZLVIulMTGK15KiVqteKJ9rEBlt3HBk090V3JkQrVze72LO3K9LYhjk10zpHZjcx7PlCbRTH7IQ1DVRohEWL55PbMuTcOIMDiKMs5/snmyoqpyekVHOja9UHE6w3FqtVOcmog8g0E6n7ybOjy2KIWBK8UnqbW0M1ncXWptrh+AmWFjf9zGtbGoh31pqWhXN6qVXV2rUSnOKYzBs7qPbVHOPR2xuna4MFR0jJ9OPUxsLpkitISmKsujUG1OgHa31kfJSK6LwSvRNqCnWbs4uo+ag7eDwYZgkMEzXW62d5FkyaFBt3A/IWmEp8K7fa/UkTGDzEnTnTlHQskgq6SznTOsv3U5s2Z5fIJbIZ5XsVNF05RokDGQUSJbl5OHyFqDUXemdTtY1JvNaH5zvik1n5tHPnm+kkZEfuZ0g0JJeHZugKwvippDgWzhM75IJlM/lmWGMdg6cVK+tsltgbwpbiq0OryWpja2zZYfQMM3T1YurMJ5QHmZZsFAjptGOJzauylUnpBOkJRfxZdtha5jgautaHaLninEr7G6LbSynZKgqS+oypeOcEuYTKJ3y7Vq0lvDbk2fa0yLQp9zsMmJhmRlll6XucSBr4erpcvcXd5SWjtC3md0eTk/kl1Zs42lqzZ+Z8m4q4wceYONckpVYnyfm0eQb6ScNFPSSECSLa6HnVgtznW8S8eeLXKCS2CpVVvYeFfHJKS+WzmpY7U9Q3ovTs+UOIJBYKpDx5lJk57ANoYky0uUr6dETFeKOopPUtVvRICpeGd4WHSkLniJThkBsaB03D24QnTMrrmgK0CwONJi1D5yzHV8RC+ajnCkfkKeRaJCMJA5W5q5u0mhXUmx1mRGOGmNpKBqM3F3esihfZu11JhDUEplwL9jWqt5YaGfta7DPEyoYGSANH1+O1nGSo+wonc+w9FoT3xLToiDZ2eFelhsuK9lh5S5aC4kpDtDf9UmnWVzVMzFpIWdrjNlpUmbcYxmJcaNMiV2ZUiat0ujXkhHrVHRfItyfMY1QVtgy6K+escss5XFoitRv30uuVExWE5plMLEe7DQ0V64jTVgfciih816PM9cWb9pWqRiyIzSOFyywbdZhDGdRXOqUVe3fmSgMdivk6tTuTNuRr9hy0k5wFdGKnCZc0+XS39kajSHL1A+W4mtWYiej1eZpWnZPKJMOT1jkMM2cbVwg0koyTnKXswrXEPEybN8Ry451UZmqsJOYT/MmCkiqX+StGaaOie5L2tPeD1TOl6fQjrCcoSvWsDJr3g2czR8VJx2Z1c/o8akOH82bj6572XpaeOf2zdgeYdtN6owsLcng8tdSNM/tiCezzu3dihAnZIglToxTU+pszijlpZhjb2gODKYkjqEnnswtEVjWMiLPHRIrC+ino3FuyrIWcuFTDCSY5NqRrts2DqcPYJAns9rXLSndlCHGqSHv6xUt6w5kGeCiyG6oLeQS9VifbR3Xa+eWKSpUlGfz8VMWSZppKdkvFavVU1ORDHHzL9UnEbX0LVupo6Ch8F7aY1xuJyoMZ56mJ5pYUXAOz6Kq8rRt18bti+FOXmAgcJjp3g+a5ana8evdaJGSirHkFGkZUW1wclywVAimaTJu4fdOcdRPodtcOBdxji0XZG6bHe2eXaqcGmetlJLoIpWSKsynnWbOWayLbtkHqyAK4C8xrtKsZktvs2sVECptVBwmbqId0ybc8VRVkthdYM4flZ5lCOBrE1gkUWXc7TVmMVINDagvkpcMSxFzTbHM81afD7WOsbWmVN0cWdBQUmwrYDRj7MqukF8Ire8i0hxU3h+hTWDsa5WwVN/4FZAgFPJxE6fo2K+nperxqHWfdGFls/KNFdkPVOAVbikq0LMh8BZh1xMX6o2vXl4J1qmr0uSVLyMhzOCmUjTUKGWIadmZbowk3GroVWuTVZ8klCHyTNQxt/Fdep+Sq+bfZJJQNhOeXM9jnKTlIGd1dJfjlRVdjqthTurPFBLv79QM1E9MW9dYo9R1WRXSGR3NpeAa5F2Z1q9n9ZVg8stZbC8JHrOJcqALnZHpFzIK8SE11uYYTOyXHSkxUSNpVQ4x5FiPnAmaSu4aMW/Y9/LdlW4nlC3Pl5FW1xq1VLSQVG8TcCadKVsQ6A5uVaWjqRomGtSuGTB0UGNir5TeDpIhHvXdoeoqJo5wdRThIm2ija0UKy9tDPAXsjdoTaYe3tsqWfcdElVj3tPblQdSk6+3T1cPm4pQq6TTcA0Opo8XrBxsYovyYc0gU5OqoWRKXdDzZSdirZVytaefF+aSZiIyEEvnDM9fXxKQ6JaNHPaSWWXVc6xgWJeRX00f7BryTzYOcV/V3JHZNldP2yRuWBjoTi8oT7DwXe1gzQia3pYfGWxrGp4nTI8kHBEaL9qf9GGNy9kZUqdp7FMYJZysJfbTaOGsm9grH5iMGCH3OFfi59janhSnslmMInEjzxYRtNyuruyV4JirzejYpaocaWToLW/JdBQS3W7lqpny1bLWDZ1QcWlrWIwpaGzsYZaiqFKdT0lKsAvT7atbK2DnnJaYct7b3guzHVrfIncRUzHm76vn0QukVVsfEuNk2JbYGi1KbKnn7opLVo3l5N3ErpIYoCmuKPLnDufij/NTnS5kTSZxH5xL6OIRHhudLjTOD83bCpYrJpWQrm+VE6DPpg6QH+afnzYqJpVgpultEGkNSOmUTNtzkRcpJdFiniLzTR4dcGP0SFhPcJxbG6dWsq8TJaedV9Bnrs9zHlWsoRrjKJ8IU1tv8J7vbM4Mr9ob0RUXN1Ts4qbYb2sQE5f4ESErFVSV7LLy485sLGhI7bIN5apRUBo0q5KXzi0oiKEY8NRPCZBMHBCqTl9v0yEIVupzth1cYpZUVXZVz5Km3ydVD2ao6K0oX2ykV6VwqOZsGthKLKTv9i0OqK6IqK5MqnSPsGKfF9ydF/To2qrL1aRyzwompSxXo9IXMB/QJ6xgsqjYmw9tzZtjc2VbmegfnJZuaUuO70l1r4yOc6HzLey2DxUXFbuaEKqwi9ASrTdSVRfwMyeV2g9lHo8ntO7o4ZDaaSWeXOdZn6RTIZGpGCAwc+kojOaiLx6Q7ytrllEkdFjSrdyUEx2WqBAtoGntlHgz5dkdlN7bJGtaJ/GP3SrjS6BpbFQJVV+mHGkmjlqi0pSV0OwezY0uaJuUmqQRd2mnXvQNsiuRkFMrZi4YEhbjK1VwzXUWjQ0T7BwnnqtfatsVI+AjXFpvIqeS763fLhdl7OWIYFCI6elTM+Z0XZaVW7QHSoqttZgpreoqGiOs8uJjF5WypExx2RiS1BPdVtkmG+SS8M3R86BrWGJaV7Xhc9QbJJSqYKBaU5IsYkus0DDYzic2Y65znpbK1Gej7Vww2+xqHezXWe+iYhSgmFRoNRfaFkfZmG5OMqvpnPBQrLLfS6jScl5nTeleJlLb0RGh72tyJEsaKlQtb0jjYBslLGRLJqyllfIz1ykooSMNseKia6jp2atKnWkM5FbtZpoXYd0S7J6YqR8O2JDzEePg3pLtjh4M6OhdkyYJ4zEiUmVvJutTndctZunoCt0RD+HpjZaSnJKT2THNxpLq1XBgMVHuchrb1qvT8mGkBCjTT+SinCRgn9ywKZtbaReymugNJ1K0GSYMaSfOa9pejM6QZG4VVFyYWx6aCm8u6mL0jdcxjFUn4xfyWJVc8IoK29efzlhW5upcEKwMcXPuE90nG5Tu7OHzSdYdH4lwj1cS3K3Tqt90MQ/zZ890nqdVC9rcqTTr70xqoZmnaTRq4dwlspPZ6BUrmOsoWhfN75RVkQzdtJKqkVbt02Uz7JOSi6azlwonka8Z5IwfaF/bbg8VZyvp51omHCmqnSgMZyNi0NZuFI8hXqCX3hlVaIqO2dJK3bKbsyNODu6207Fdn9OerZWeSeqfJxXObtxQFxJJ8EtOLyWYmiGRkShwsKPimOxkFpdJs9NeqmIfqGDt2dEdCiAhHqvXpQ1W6ptRj2A5EyzMMIrZbrOf9g6TpIzjINrltNLyrRbpjasm4mwYKpMss7VWaTAw8linkZnqFiumZHNSGmXy3OxVHGhmH9ckbHUPoO+X52Ki3q5s0m3oF1MiR0qtDXAO5iCdJo1sT9wnE/Laq5fpSeVhqKJnTxPYn5ormXFxLssfF6wkJWMUjnZw6ZhZjRKy1xOmUmaXxyOgWh4eEFshS5BztV+gTSGxZvQeIXQkzy+XnFdKpecpoK4Hh1L2GdFmqBGcXKxOXl9wb9BVUBZmKGdxC7RkB+ns8GsSouYyTeyVSo3TDGnfa6bgq02aLwmoz+gR5woYDaet8hmflHAVzh3ak7LVmzXOrs9pqySwXKFh629rKakJDq3OIQ2bKgsc3M9hMae1FAjP1Vai1CBmEFRks+vb2s/Uqy7kNdWLlVLfXK6ISi4L6VrdHDSS6ueL66eWW+bNMN5wU99bJ1pfF5eRbxtkyyGS2hoS7BSnIkzuEdWWYSXO4XJmE7WaHtcY3dQoUtapbWBOaGAfVFeu7+WQag46EJvgMPUOV4psHKMu5NrKU3AeJR5UqiAWJU4q2dei5qyvoVvPldWibSzg9I4Oqiut0yKh3zTY22ulF51Z5p4lUmsl6ohnH56vNGrvCOxprZPPkNyZchQz7yy2YdzSaHQiyIRv0VssJyiOziwVJnhYn9vOoK0xG2cH2KYaGSi0c3DSj3USbRkgbIfTJVWzLbUVGLGkT5uxi+ESFK3Uk1bU8WqY7UekptwLzfJTrVFvR2ZXHh+gY60hbNlQs6tZTIywpSzUXOblrZ0YaZdVuVlYICnXMZyKsWJgU3JKICSVU+RkJM707GQY0dwOShuaGGVetE/YDwtjV5aabZkSWTCiYaxsYN2L7bJm7prhjaWy7jHSMVjqU66cXSGsKfPwJGXQ3Odgz1PZ7KpsWRE2DlEoEhZfmK4w0+W1DFHWI6fS5xxoVCRMDtiJrU5Sm3PwGi7qKaGnZlVoZUzr8otyHihZk+2Q7iZWj1fqDl0fIwospmOgNraP4COhMp9Z659L664jUqqcSNPv7iuqLlmrZFweKvCUc65m3FZ2unMPZ+PdMyaeiiMukePW4J/sp59rG6ftse718ZZvk8snzKkXTRtm6FGwXdELze7OnHMTHvVvGM5MG0mrFB0aFS4zH9kiYZzeXRydKyOyZFHUJgz2p6Jom84IafPo1vNnH5SKWu8zkV1XJ1ZnqE8bMtRuoVfgLlkSm02r2aMVLrDzTSkjmRwro9xqNtTgbG7ymHHPsV3wXwme29XiiTDyEl/dHIulUuiaVPPyovVYH6ncKWAOaO1a0a6SsSDfcRZnG61ZVNZdJkZZU2It061ebA1pmfcp7uVQ8tXaU1MiKe6tjE5RlV+cZh1WLk9NXfTlVRRoIOdV7hPPbqsY5WOczeQIpjMgU9yjrA3pjqydnXZlzO/kW+2sjzOO6UrtiNzX8WbrK5kXbUbfiCWEYKsodE0taM/t4qwNmWXppnNvSxfnnddrGO8XT3bTGW3X2dVJnCvdCmQojdkpaJFh5VTN0UlmElHpbFevLocyoNRxXPFmGtfWqZNUCbWwXqZ0r+XmNU2kkbCk7q9adIhmm0se2BXWPBajZu5qjB3irWV2qd4Z4C/1VFgdkXK2lGOa6Vh0lOWb6hMQ1pTtaSba21003l6fMU0bX28aTdEyhhZVFniy7PbqaEkPsBeLmFbRHciVm96j3M2gZKdrjlU2rlcoohDN5qPQq07RWF/zIwyYoWv1MjTIXlKHqBHgn5bd3tRb5dmZrtXt2GCOXyoYYxRPoUmn284ZqujoqYuU7ZouCtbSbg5OkR+PFxVo9DOebtfh65zOEesloiDgU95QTxNRrSHwYZVZzecl0PIXqMqr7uZmDGwgH+5papRZcJl38M1Sm53p8gxdHrUZFd9ZKhRxFBF4HS4LWKgUYidgWeAw6p6WCpnx6GCVKdFuUhkIYtokIB8cXnBedV3dVtXdEKjUnnXfnZLqpAzqZZBZ8GUlDR2nG1WSkJno5vEUbZ3u1E4XUrBf0FSPdFc2nO4WMw5lzw9YsZauya4QGakzSifgzO9eXygT1uJPVV5j35PqGGnPDN+qSuZRlJXm8UeJrYyuTmxY7N2N7RsObM2hka2hRe8sTKirKJfNouRQaoodIKQckCpk8Sp2jKpjVKEoiqpfTOenEi4bZh3jb54OGB9aZy7fIrBxo0id0Cnyj+fPkzJv6vOsEtpl0yDmGMzjtFsZnVfOL13h0nDrTs2LDB4VZNkMDJQMp1NlF5GTaGwwaKUYq9OPaeHTEF6XdeVmz9QpKpgno8rX9PFWWRH1aejM82I0Vy0f1B3xk2mpnZ7amKRiWQ6qLfCktDAeVnHdrc/b3+TYrBZlHA6ic2oq16MbmmZrKu7tSQ5lytsbLFdwLSRhpt5mV5oP8fKUWauNUqJ07aImBkvl4Kpd2UzyqNpyzM4NqWRV7qMQVmtL6hbdJI0v39tVE9j2qTXaYzBw8ZDXb6/x6uhYEJbj6OqkUk8U5KaWsIqq2XNpFLEOcdNm4FkL8NPfbKGcsGbtLcbVpcedFCZpVE8u6ZEMj1+zI58p2U5esatWVB2qELdRrl9O0NQkHl8jnXbSGZtTolsVF59VXtDe7BVgEguoq4kd5o7hXyWyKvPwUOIxbdVTkWANT6Nd0Sq1Zxse7g0QIaNty5NVTlXmoBrgYZiZ6qflrEpxKVWU8jMinpORkfhns+fgYunvYCKu8udkUNBS8DIcmc+djlCUGi8ZlvLw2JHtWWLMJ2Fw58mIsqsL86Wwnq7oFuPV2xIYhlRC5BMqUq3qjV1rBd9qC42N5ehk36ahMx/imlRU0e/LmlBYlqh0cJfq69FMUvXRpUgqki4hMpmmt2fhnI+hIaBwSrIZbUuuF6Lmc/HyJ85UEC7iUeOSnrVVo9JhIeWJcHEJKFfb17FpidUwXjQt7umbXdhfIVrOIqeRYe1qkRMlGnPwZbCWUw7iDqSTbPOWIuyhVfIeDaBLTuGnlsuKkSuu3cyvD9nMCa6eY1Ud11IlK5MNSq5uz/QRsgxkMAwYlnanE49ctVevYJ+cNNLdErgXUlFsFFAhJtrNTwzO6xsp1k5ZdRGujBFz5SxKjCZRFHCrV+WqbV/nUeld9ZQiHtyiLydqVqUacLMYTG+s8HQjX+FWShNymeDOjK4sSPLz3K823askpi9zR1CtUkmy8OG4WZxq7S9RIK7wUxTubWZli1ZMSaZVB5HlLWbaJVrckCPcI2+bk1YNia5I1sox1+GRDrdTWm9g7w4yzSaS6ZFf6pfQJeFjMeGcsGoUlhVfks3hniWsbK5iH5ikECNY9RQRkBqR4TCd2k3tUGdmDk6aoJzySZGiq5uT4xVmZdu5828qbmWPseLUzXTK2hzhViVLo6aoG5bhHXRQHg+SrpXp2KBMapczKOITcnFy7m5XXHQbz6VNHCJT8KZPMO/t6ppnjlUu0hYiLlRhjR/xKGrjp6FkrvAlLzRcZAtdS6Sv9s1kqxoziycotk9YZ4vqy0vxrJ+Ni5tLU+QM96uSsXGZK2WypxRQKR5PUyqt13Huzd+s4GBZ8KQnUxr3Tu/fpJRt8FOTM13nYE6ZeTURsmnmiOClmBzf4YqhjxmfjhhUmVmSpLHxnF1zDl6zElZpoxtTMhjj52+MV1sw8mDLUM8I8t0a585O5CkfrGcLoVrddPXplZ2o1NNONO7Qb6KSUZPNqvEO7HBy8mRR4/GMS9Mk31ebDptk5wlkE09t3mKn0qzQNGqZ8evZmO5sEaPwzC+y7mTQW3JdbHAQVeKOkAmuKTIeJk0aU6aT5GukmgxtEGJeT5YRG2Ma1Z6kn/Pkpx+YirRIIlaR6rFK5S7Nkw7Srk3pzKjXmqpK6ali69jKnA+Vk12xLZZVb2ejFS1mVajmMxwwVTOVni3i1O7fKScdEOwrWFvQcnCyjJqnI/PQmk6x8BvhaqfXK8ym6ynv1WNnjKKrXudU9U14n0ejpSaopS+tI01YlnXc2pCWpeKP3BVpG1mgIrLlLtpuTBtPVGX04h6Jqo4b5xHu0LMxk7fvkF4VzKBe2p8tsJkZcxaPUZ2eU1xPlR8zXdePpdK1Yd8dIvGglxiTYSKRo9KVL9Fqa2LgIpNymGDWH+tYEU+MpzBq6t9tz+Gf8ijpSuoJ7+yuVyhix1FzpS3cJhlQjqMa5mORXV/k0h2bLSRr7SZvCVhlaVGjbqSPlZwvIJ8PUNcwDFiPXNog2s8YWKfLUBLwYlnorZZjIFgxs1Q1zc0XshOzmJoSJ9XmEhIULe8KsEbWF+Eb7+afkVQU6E82XhP03uHTr/WknBbzWdwobFoXrFQkZoyMJ8skFtWq5FyhZ22RFFv07drfne0ecBGX6/AUIOYyqJJMmGahCyChpW1dGyBWzWApctfScFktHyWnZpxtby8SJrHL9qKN48v1Ks8inpoQ4Jl2rp+ZlSJXW+zsmpZjGtHdUU7zzfBh4WeR0OlkbZPekjPxDOPtskr2J+62LHWbo3XyU1QhkdXkVhuhUO5hC6eh7o5dmm5z26LR7WKjJKdSMiwyzB5hsuchWCbr4NGhmV3MaSUcjTIdsEphyRoqpXXeTSZyb9JfDKhLqC7giaWqGN4kqzDrmjFwn95sUZnYbdiyqVytmNn3HtsS6ZiV1K2nl8yQG+kTMeSYFyfo6ovVMmksc2p4KHFPDSdVjO+2Ehwi2m2dKJ5qKc6W0DLnW2PisqvlaylQsknVjJ7VT9wrU8irFPThJyom5djvZu9Tb/CR2BHerc9q8uiU3lPejV6VtLBKFRlfMOOtblFSkxkdahzdM/KXEGfdrWKjJHBfy9DO3q/yEJcXrVmiEinoDKFvDRPLLVdkMSiTK+vN75DjMRbNaCLS1jgK4uEJcK7qMiDL2evH6F31o1IYpM7d8uBqc2Pg49vn4qEapOvT4RKnWaxVlEzaCtHK9CuWDdimLjFzT45NjY5Q88ZQc7FhUurm22qv8x5jI513nglQqaNbYc+gVm/elout9dOzVAwsmabPMpta8hdRoKZvF9TSVK9ujtWKqe+iU2baJs9cIpZtYCtZ4XKy9ORKtE0Un2fTYZqPkpnbG+yWjaDsHdr2GBuh046zae2WHPcVJhGT8mzi1ZkLq+cu4TMtHrBfCGvv7smj5uhWbE5PEF7x3V4V3GalFVgY8JJm1o0TEV5KIRpLmU6xFdj5UqNLGbNy1GFoiurqXJk0FWNjSRfS6GkoXaKU5N5S4xSiMCtPS9PylCL1Hs3okuvOaCsljCCu3Q/hblCfJPKebh1NaJ/xKFpY3GwNGdJj3covU2LZcyRc4uvPkUdrlxLMWNHQ6erUHW7o71RTtxwqCyyO6WJZ8Y0LnWzRUFfOq51fWLAN42J0Y60N3IzyatNVE5tqmWVo22BZr18lD6aTdClRaQ4VGlTony3QpBj03RugkMxxC7Kn3SFsIEvX3tahDxmon63HoyJmSuGr8GiX6g8YlZQyymRU1W1viG3sI6oaHZArGw3b6ZSxyktfJ6xaz07tcejrqsbe7RcTL9u1jWTVLPIjb1xsKJI1N0yxmWOnTtBxa2VYDiEbqZnl5OoKUSTwds3vbA6W1eZK7aTnpKgN7ghv1d+JYazMUDa2J9NRME2pMONskxlTjR1yHXChrbEM7hDo7elwp5EqjytiUi2e1p4Y81KpSdNiTlnc1VNbtc7XlC/YaSn21eLupuKe1qQNXSwgpC8toZmQrxSTb+CTFY7dzeqmDO5yzhZUqacjXuDuVh4ssLDVXA5TEg31FA2ZFp9f3FtbKxYco5UdLiXZY53mqKNSaeHplZRYV5MI8U7dh96Zpu0eW5ZqoJZrJuFiEG8h4ArZnh4jzQourpHUUOcdyXCPGA4nMh7ipPSVYPQo4tVUK5HbH1YUorCPdGNUTdcvTRIb2oovjWepl7BXjoom0ORm8+rSaAeYIHAoz5AsXScRSe1nZpOU7XIV4J9w2cbhm+D0sGIxIN5M3Z/jyUupqw9hKl3bX0YaJjDj9GHfbGZg38tnbYjTGNaZrx3S19btj7P25V5kDBLYpGUMpqAnt1Lh5S7XM6/k7esrLqSk75XfZpwcdNPL2q5qqtCX8IjucTDIr2wM6NLMGnbULtPvEyrvSixPKhpVoS6oClXzz+FKUGnw6iwgo1xXJyHrKl4bFijka5Jl08+visypG2+rYatlZqYR2Vpyj+na4A/ileiOMR8Ra1FXZVZzVpPl8yGas8mdWwnfJmqS6hFc8OTe118o3dOS7BesbW7um1Dd5Bs1rQ3RkqDnok6uMKWrjW5xGxesowyc3l4XoG6mppkPaZjxzzbUlSynJqorbmUdimql49EXniQoKSCk85AVaO+uHOxgoa6q5p3zpjAMqJf3GNGbW9pm018bsy5vDQmm5t9ZjifoKk2y6pzS4O801jUb3Bua3nNZml6c3B8sUyRd33N1jnLOj7TQoqt1G62mluqWGPIQV9zuKZLwyE5VT1incR/g5fCfbRUgXMvhatpxJZAMyOTL466wVtgr6/SetXejpGIdJHEMCbWaHKdjdSzQ8ouk5OJ3DR7aj/KTs8+TleobY7IZp7Hj0pMi1l9fctyd5FjsDA2QUmrfFUgu3m1IqTNWnFGdUkfYrlbP09BdbCGy1lTfzXfqSlcKaZWYWPOmHksgHo/NnJX1XarS7mDYqqoKbuwzr62Ty6ioVtqRWtGkZitp3gyrKHDj5WbfsUhwH0xRGKEfzTkcjMy2GxdOEKkRj+cKEJmqVp6YY2/Xnp4eELBR5V0ybRLK4BiyYZPxNBgjYqFTI1BZVeZn11ly3jOZSO6lMNTiXdnxMCLqbe/qnsrO4A6V5ZmjbUxjZq0a6yVSbtGdZ62wS6iP81AkGtYm7GXumk8lq+NaGxQWZ6oYIdKuLiAMD2+uypbW3JFIhu4jGe2fmB+eXvGxxtfuqdgwGt0yrhIan+vQl5WMqO2O1e1TXxWjF+csbsbQVCwoTxUm0ebcVSlhz6wXCEzn0qHS93NUI5lbU+tu1uUJjJWUMWPlmYxvmKWbFihQ4u0cDVwN8RKSFezQGWA0klrWkehlWxzkUxBnqi9cW+Tt4k6gL5bla07vDnGYKCPVddicjM6n7ZWvpB/NCt1bCaaTHClRIt/SFHle65WMbGYm31hpGKPQEfCsTy3ak+7dq8/QVV4Xm8oWcYgzrIjn25ZV4W40bhIW3PZU3h4nlK8haw+cF+3scTB2aF3bIZ6zY6zl5o9sDG4skBt0UHXgjk6Y0ayscmUJ1dLj+V0c6ySqWS8mYVTYZrHaj+3p9HI0J6DVoOkL80eoryftFOZrCnOTbLGek9DSkxTi7ImjL01YoltP81wVU1e1MJKxsGlH11ce5aAUEaeZNBzUnNiPGblNWhMtzqqtHTNREtLsYyXrjivgMaSgKKXcotiS6Fg1HdpbUpl4W4wPIS3VWhbUndwj8lnRsVoajM3aJ84jS20L8wmjR18v0nIc42RjJktMmY6qHNzYTTFupipNnx3tV4xcpWyaa5Ff9GtOsI6UIueSjJ+trd4dHQ9f6BtN3u+Xzp9ioZwMFLQjLOOaHCHOzSCgpRegoejmIdThpOEU1jBpF1se2i8dx9yYZI8WJ0enBlwTNRVsTaFnUWKhEVry8VWTchbtL+9O5tBjoBaohONsLQktqikRIuXoCKUXIwQt8m50K180C6IdKt9oRu6uXxEr2m8gzNMiWcmwZ+AiYmLxEXGbK+SuXNXSZiYZFWVP2ufd2HDv7wtV3l4tZRdmHK9MMlCVpRxgB6vxcxD149ChIthR7WfbDOP09JsP5GgpaKByYpfxzLCn+KTwIxRNFeQbcVngqcqtr+TkJgxbapvz1onls+fLlJplIbIWMiNPpejhsNWrbArRkiTIylTon1ZTjhbroQXtYqFU1d0fqQjvFiOKZPSw4euXDyhLG5lKblvYL9bxy+1dq1HVKODVXJlnH1oqj+fxp2mT8Q4kIZSzClJa5nQPzfGrK/OK8hwqztZbL/OW2VEraKAeGa3f2mIloiPlE9brd2aXl1wYcQpvlBpiV9zLpHEWomBjUutdXfCQrEinGBEhNM/ooRkLZZuvTxZUk99fJSyTcGMRqqs3HKZaGuKks2uLYw6WbWlPG9Uazu8ong10TbDObPDq886WL2bUcqpjqxJxsaqi4aJR2ZPQmS8W3mMZnSyhVAvjKsrgtVYry22W8xKimxquGWUkUtweWWtaqlMSnektX8yTZBLn05/SJZ+kFONhpXj2EiMcjdfkLNLQNOQmWeHfq2FgD+IF5afd0eM2btzgZhaoJi1ZWpBOMPKUCPTaD9YqFuO0216cM16MjZbyBnCbketvNQ2jMRDY6nEsKa4W5l+enk+U2BXsW6pbFgAXa5rn4CqK6hMv56GR8ESKrOQm38pcTckgp7CluZaQq3HRsV/L4A+kD+yU65ATDeXiibFREe5UrJwPstAc7MngU1OaadTQmQ/vbsoxmvYWDVrgcM+qaGwb1KYZKDAPVtgqDSauaqwumZhrWO2j1K1ZXNOd6dsu8t+jql2x47acMVpjlxValJzgGzT0jbLppOtfECVYVqQhU+WPid2JmxojzlIznAcW6so1iw0tWViq6hiR87f0ymseyeJb0hzbnSyZks36NZNg2CfkXTEb6+qN19pTFp8vETU3bNgSWSYr9FbN5FyfKSBri2G3JNFX7O5kadCc1usxMKYPKeCo5x+PEVxSchJdJHBjC9fNs5vX828S8XdU6CxrLinuDGpyGqRYNiUXLw8hqm6tFp9fG2FuDXFT4hhPo+5iT97kklUpENfhKFtUbF3i1W0KrFC0sxoV3R2mruoZbF3V3a8LlBPpS7Dr3tixYt4qqxtVpImyXCOvjNUcD/HXWVzq7szsIisOUFIzkTUPm5gkV1lX2gqbbrMcWa2WWZGwZ52TofNiXNm3ug8oISPbs4oRcXdNUBfpUGLJsCPuaCnu3t3ctjCSydOxolnul9Rl3mkTzbCS6LBv1hZXHLcUL+rfEbF1744Qrctq0V9eJPajEyuezyRm6+iNMbVOzxiflBul5ocrKk6lYkpcW/Lj5EuIKOyaJ5bS2M0wEfLjCl0WXC9kpJKj81Uzam4rG2hvVnDhSm/MHu3JHfQbDxJyHuIr108miNnU6XGwqltjDyfMbzEWlRKNpVNWVd8uylmREfJ1aA+OKtae7ecUjZ6N0hWf6gyvCS9i0OMrLK4Ni8ugalld8VGOas8tmiXW5FpfTFDKr2aI8a+LVRkyVWLukLIrYvETOvYL3SUPY3Ij9Urrzp1sIp7sGHAbNnEONZus4vXq4GGaWHJibBnYGzSWHnUqX47hsqRQHKDOL1cPqh5pYdZb6ltzdZBQcWJpiKsibpPVNNKeKueLkckjrW4UIp1T3+QopNbVo6hhX9qTL6Wl49QxmlXoU9vrzdyMjGqT25/sEV1LXRoNIZ0e1dLPZ1AoZhtVH6hwI1Fg6zPt4HDjMmkSsCFpFQ/t9FTr0uqIJyYJsK/d6lLQI9xV8hbeDtBWHVKUrFiS3bNnntPx2CzyaSSeb5zsk5OldhEdy9hv5onRDqZKmd/ppdTSdCDQ6FYVNPmuKpipcWHl5eiyX+2q8qELDNJtlVrj68xWISXP7zFZD6wxFBbj8xQvcNUfXvZRINtfzdYn0e4ZmS7pMZNZa9dfzR6dXZIW6otZK9dKYHBc3u6K214doDTRc11SKkzOLZjqLoqPJWMj36AnJ1DYnOsY0mEoKc6oHvVXZepdWKeuL1Rln+YUrhjM7u/z6gmaat/PUiALaxMx02Tn8ZmilS+X8UvpEGW1NM7b2nbPNkmis0inrtDUZS3qYewmXecnpMxSMh34EfWZiYutZ5TMlB1bndR14EyPL9ASqluwKVyFowZkXmXXr+NPkbCx5pnl7M7Zpwze7GnoLCpwWSZO7vOeFC0jIJlfc+RSNlqkjG4tk05Wsc0l5m0yEPDhFc4jqmPdog/UC+SOzpK0HyAf2c5X7ePPkCZqD5VYIWBYkZ2mmg0dl95pye5Q75lkaicPVVdqLpKTGWEUMwrZGCovF9qM3WYyMnBrm+8fJ0pM5ZNnJVgK62/yFIqvMLay2y8WifDUKtPfY6HXt2opZBLnWJHsGg/uS192bE6hMgoo5mzt1+KesB0OWuCf0m0RT+Alz6NdX+kX9OQiYvKdWJxvLFIz3JBnEh+0j4/YH28NIiGoMO2m0pzbVp/0ll1TqlwOrW7ijtBydo/mKbQWo+prZuE1ZKwQsHWt6+PYLvEe7PK6TVkmXGJQmKKbrtzQDRlu0my01q6PUBZUb9gkael01uxV+2veW7cKmo1fl3cwHdnSLx1isKyhYU6jbtQZpaQ06extLyVlaGZRLFWpZUqpCxqoZu7xqNbZp1FqlB8N0WUNZKxr4mzfxwtVYm73neWbBiLonaxkrxqM2I7NnWLo5RzYaVGUE2A03mTdlxVfp1kuEeQTHqui2PLRXZKHBeQujSyhXBaisFpyllvxUBwhVBkr1CqjEVXNDmwZWOBvBq3dnIzfNC2NdNEzaE+ql+BwaOfX1N6S9I8wG0/5GSUjtJGaqszz0nIQphSN1lnU5tXc5yaPbmMo2O3NL19Qq+grmokmoWZbb+Nwm7GP4izYC9Jwk+ySrTBXX8egoGLd4BflndNNzYrz8AzzTZVaGJSUaEr065U0ZE5crRTVMhspU+HpluTY4jTn4iuMVylW0oxYFmSuEFGaUnbtCyjxlug1Ftrup6PJUocmJS1hDokv8M3jye5i0x4ZY2sn4JhSsaslE0+g6OotGZVPz5axlY8hZKfb7htfoaRxFqbLqbSWY81W243O8e7Kzk8JSp6gNU5aplAnp6ccadkmlpuZKmhVbRkYVOl8mOpQNFePbQ8m6stkZaaaCepwntow1otHo8xtWg4VmCBYKlqxEmWdmorQTZYpktKvTbMOIh+MzNivEY6xk9auQtxbYBdr4hiUSebhEsssFVAU3BZXNNOlDZEJ0OOVH17zk14ykdm2DiLupOtSG8qyJVZxpW3M2hhJjY1nbBmVkETqrC5oNNZNDlGWEibTG+grV6ALVJxWuilXLYgkHItQL1j1ol+1H9bwHxppoKknsKubmJtrci2lbpBSDLElVG3pMGHIp4vzZ5dWiucWoBjUZq1Wi+AzHpMtXR1mLvGxE1Urno+imXaW3vNvMa4pF2lVZ23vjrfkdVLUpSQX1awcWvEy5tEaESAS9t0bmjKiCvHwVqjM21Ez0qFj5O4v2s8t8GpjId+d8tOMEiUm7swhop1PiQafqlaYlc/VYm5OIY6XFOijUDHdyxUyJPkSJk3KKuKmXMrZYk/1MsmnYeBvMWkXIS4jF1TRas/n1ROe4THk3Iylk+Ho4FLTSmDkUzdRFilhS9sxIRViEmU1YQ4sjh9bXuYWzNFUkoiO6lojrrJNpfEUmhpXJ+3H4m+uch6VTdWo6KWMy9ociO2mi1XN8guVKNhitJaUTNI0a9Co7RJU7+jo450iY1ikYp9poxac6TMSMaJVLqFl1HgrLXdRaJIZm57fj+9n8g1N0CNVUelgURso1N+ZsMxxHWpTV5zw4E5PldqksY6h0JddEFditmXhn1kOZG50D5yzX+go4pFxci9UE47W9iLZkRfmUCJnUp8y31FUoBwv6Kegi4traCilNHcmi1llSKNRkKeVmhQd7JGk2hLe1daWETJSkZxV5d8SR+8a4WAjVRJRrijvbAVHTacxdAgiFzGeKlAmS9SosFspco/gtueOWbIRVVuh8g+KI7AR0VJvKWes0MWeYZaWaZ7xrlLOqGNoEPDeqm2lVJhgjiGy2zJr41es3OELXqWr5RzT2aarkZDsKnOe3FxanRSTDu4Q0hoaMykc85ELTF7QU6VeYVnJcA7n5FwmmbHQMYos7x+ftSAYz2uQKarlZmmgUmcXWitRMaTSoRi0XtqZJTDc2ZnqTVbdDqMPW1gt7Q5Z0uTia61Znu6hIqEbG93KoXHc69djVjnRpRNloHUgNs1cnOCzUWklJS1w1+lKYFnzN3HXtdZWaG7VYSZTLTiP5ExPYcxuYTC63RKarmQs35RumzCe7AmoSach7RsfVmrmM9hkmZHbS2OqGNOJ01yb52XeyzOSsyjQ2XaX4g0zXcvMKkrX7abpbeeQMmGlc/LVdd0M0PHtTexuVJcHl+vS3SnIZN6NK2Pa0KCrLhavF9bk7QvTSybTGRimWnaPzpdP71bi5dHjVZLf6lj3ENgko5yy7K/N8WViouuYjnDjb+QxVtlw4FPqdPFWTowK6x0pH+BrHB7ccRrnFwthpXARHy4S3FTvFehl02xMJVNwtF/lLltpaaLnW6Ku21MXYSFycpIw4ZummexdHs9oiOXKcNDVEB2SJyqZ8c4XaGueC3Pylp+uKCDkzRWs02WxYJnn568i3+4YbjTtKmaVhJxblqhfaaXbX8/s4prbzgwnNLQRT4wdMEvfKRAKKHMfjVLurpDnYpinLxMlop6rK/GgD+QrziUrGrHllDGdW5tVjyfwIp5rMY6Yms7QXBazL6SjNtgPYo6Ry9muc/DlV19hIWLUKKoyo+Eo16PS1Caka1klmRcjEgjrI5dVZbSK6WknZaWuZxPa0eFSVlaP5OXa2yfT8/PlrZuuDTUiskuxcQ/12BetVg3t7Qsv1JOpTak0lQnYsXUl7YwW9VSajNdfrBHkmqNPFOCLZPQf6x6U3LAc8Q5yuByccPNU2k8e7Z1cHfSu7ZUR6U7xEKxRoJPnbFllWGSeo3BI3Oklb+Kebaqu3KjjMyXVokrjV90wqTCuG1edYkyRlCDni6vr19XosCYurWni7SgpVsdlkd5k3pDLTvPzrhmd7G+gog0kyBMNJ/FnUTEtlmVuMFAYlyCsMeFJZR9MYk431SMl4dUtqN9g2dG24zed6fBeohuc86NY4rLT7RFNlRaqc5PY5CyTniamoRtfjtwTIB9i8SUtB9ZHtOOjZW6VoJ3fjZUSHgghJrCqC4qpJJ9w76feHQ3QY6Fcj6TNa+ir6iHll9Cx5ZYI8a/S6PekEjNxbLCliW5aaZzgWKv0JdEX5jO2jhA3Zie4EZwUbBDp4tgra+3bHtRjZyocEWJWGtInZC8oUGVrJ2fN8SxkE87x+FaYMKELp9nhWVCezPMu6AkijPBkSClhSs0aorVSoKVXDeVgiOaWk5eZGeod0dDx6dndmBbaWKCbjmBkZKxXEXOdpFRZZA9uYtHselgRKPIqTbVh5M5uzeOQDp3cXafeYKKhIViM5ShykyPKbFhgUuNWS6fi8HRSVOkkT5OwURYWm9BypGLL1THnIDCL9pnRLDAv2V8qmm1anWFanebril0ccDVSSVanTXBhVMyqWttyke2upI1dHy3v8tJzEFmrmWcXmBmUyVUZVGNLybKMiuEp2CMi5HOS7Sffh80uHSvU2zIbqdlSW0p2J+fdjdgxKaZRFeeZrRSsJZnwzXGn3GnNYeUJ3F1jZXAjbh8MW5Jxmd3Q7+EL0FeaaaaPJaZoDxlNsBSQ3y4tcuX2jBEbClfo7rEqYCArCmBgHpcm440TW2KfJaulZzRKXQzrVNapcZGUzpVXc+PW22FV46Xb6N6p1JhUa66ZYKTS4GDLZqMrKExJLUzfMXBYMbB0Ig6lJ57Z3DDhbTFuDZSnHlkeYQ8r4k1slq3mGxntEepcUDDQKdGI4zGaTfNN4tofsaGum9HrD2ZRVnCcIi4sZN+ZTpCIbl2p8+JUWXLjHWie8moLzkySGTYW5RWUUfa2Yw4gqWBPqMvRkeqvSGQvh7NXyB9uZuwTKOIXHNQrjyXzH1hdVkpt2e0vj+sqsHarsyzm0k6g0PAOJamPrdPMo14Vh1xtpmpValIgJd43W9gpzt7u8ZVec2cwoaWS05GkiVGX1x3j6wzwJ1frUlwlTa2iHhIeERuu1ymONav3Tgyfc9TI0dms5c/RVHGk4jBkK2NvczAcyw3HEkgwDOKSIrc3NuikS2PIsidOpdfyZFvX7tEg0E7iaeaTJxrSJJeaaswsnCtpyxkynq9mGgnTIJoqGI0YlSQlKfFWnJCpF2pXUJMl32pmKfBUnMzq+CyWV4fbtt2PGe9sFCXvq+yw17FYUlgQM/ESsArIIq/19d+X7m5Y8EdoD6MRqlTzivLd6uzQ4Gtm6SOhtBHvWSca1Xgxn7ZeYfDUWpX0SNaXZOTT56XRm9/37SlVtWytR+gRTmSsCrCt7zDgY9ea5SFvVI/jlKLcFA2XozDWp7OstjNykBDajs+WMevbrThSk3OOZ4/2ph1d2c7xoVrmhc2prOBxVN3jL5dsqJilS2TSq1dZd/VakJRMGVjeF89ODQxc0GMoW9SnnLPv73LNI+SVZndineon5lQfrqNm9l6UFzORKpzjKRWOHCYoXxxckRlLjPWZ0ZhbZC1yZpiarRdgI+5hkKvwjXHT0OIW1LDS+RaWTlmjb9dozCmSaObT2q8J2BTvFUgX6o6Hp9tylB3UDzSs5K7vS5voY8oyFSIoWcvMKB0nb29nVuAu4B+0oGKWETEWjpsTEZ+s+N5T6Vqgy2qjWrIp4B1k3PpckOpMagsS7HHydiPXH40kVA6U1dzo3KtU1dbhMArUHaTnp01oGKMSsi/XlA51qpkz0xIsnkncVKJYo1HbM5UsoKDakNYXNeAyYI5zK+WYUrPWE1DOY+DbVmxXsenVS83l8Wbk2Ompk2IXm9xWp7ThEOflijAz3IwoLVI01CSV3C8R6SGk2Gcr3tWJVIXv2RLxXmnu6omr0/GzUIzO3OuOFVVaZGcPao/2ntN1GRXgHSdwDJBMj50IFN0ck2IXS2LQzFjasR0T4iJezO/sG80m2eGaHZNvmezUzBF1pg8c4+uxCVOVqJfsm1KRtGnlTYqjyWOajk3Y8A1LCONtGYwyZ+Ckx+zhbt2sI/WsbDBllpEgHFOLVulRLhZtJx6g6XQa4Vm0FJNXFE1REtol4YnszZeNGQ1YTWYqUBsNzqWopWIUj1UymY5xJnOmD61ncW/hU+gwoa8XMDKkzkuedoyYLM0zaU6fTFaKrPXZHu8SZ3IMUBPtrM1MXQllWDVZqFgLHhWmMeFyUxqlXKztFSnc7VjQaKOihiQe3KFqLOE4KrKaEZFfDqtw3xezlCTQrJbg6WVimOliD+PXWGyGavDcm5pKYV/0VwyyEK5obKRYX81ZqpYqZ9rTmSLH2DLh251uW5bjsrQ0WyENX2HkKuvPmBBW6BhmlOPrDA5pVozjHKJZsyBt6uoijnElIaUirZ2xIN+mcNvUW4mhscnz2V2e6s5i1x7tr09f6o5ZMJhuH5JU9bDrbd+doQ3o61vkYlZtslzwVu4YiiYOJhlX4iUvp5otjk5qqR4RjzTkyrBiTKxn7OpkWuGu5vAgmZjx8J/mbxJVpeTwj6waNS4SGq7XFuiapmETVKoZWexqoiqhVObzKsyK0SNZrW1h4pjlazBSo5GP65Ofileb8YnNLKhb4tZxoTXg7aoj7JYu3q7xTtTeTmamliKnTV+g7WbU2Oqk39ORHvEoFM3WTfgQLWQyDqPkcOhvKIxb7xlmKpd31xVQRtryMgpos2lhhusxDBEwWDRRV96fo2Gp7BYQo5eRz8wx33Xi457j9irXk65wB88UFA7woxtfLNyda/MOrl+np6whrHJgMokeY65MoWBc5O4484+QJDQOdM8dkVX47Y/p8BxSlB0xWRk21bEbE11trmYrm9mmUZjdspaQbNSSYM9bIUpciqdk1baR51WYJ2xYFwtaM63iI28cV6mdG1XqbV3GKqQYltqtmksoCtIYW7F5JdkmThjqFo7jaUzL5Gvm3i1isE8jbi2w6S2j6hgdoR0zWxEb8hzVV8VkK+Tsn8ueoWLP0Qyr1iuhEZMfCNzXqhBOn7DIYmq1I6Oqop+kNa3eaKOi39BcEp5mZVRdHG2wb51LDqPfZNSPzM1in9Nxr6Mxr1KMpLITMKto8k6LpWib5a3flmcVkSqmrfTSGJBcy4vJJBcb3c9uTNIsWOuGSBPy356PL9TXV2xYckpVYSgsVm1fn+Ybn5pJc54JKmxOGp2yjRQljJ3T1pPYz3ZuSuCSaKlhso1hIRcX48vLV/ES4w2TIzSpXiwGSx6g8GgTalZkJA94mh+rC9CJ4ehpoUztK+bmMFuwi9cooeFV5S5O4CChUuNKH2jn0rInjHBXIldi38nvC5smSxaVoc5gn8+0ojViUp1Tz3GxJl2hoI5qp1HoyZ3lJKViXlkQ527wj6XjsNSzs6lUnU1OCaKaUZqhWEsbYeqMCo5nzx1g4OcYTJEgEjIk7CKsUGrs1sqxI5Ekpu/Yd9rZE1zc1aqo5u9sym91FjNwT3QMUE5PmI2REKgVkFOS1+wa1RuZkRXioRwl6rMgrl9dlFA1jpMMHaRPK9ixNc6cTA6mYW9n1pVx69ZhYOSXZWIVlq5ic6lq7tXarhEgzlPm3dCMk5KgSZCvpRQlUxryVCb07IqSHpdrWhTsc5rPsRku8W6YjCAUKa9cl8uUY+CkTc9urxgkI5eqjqve6VBoYa+c1GCL7xFa4k2wbOYnZfBrlTJmlbHPuHScnImQ5DBQVh9Q2K4Willg7dOSqdycXEzuJZndadqVGWFv78qr7aSxFXaWzsq1j5FR8NpzzhllkiirrxKeaC3bSHVZ5ncRXA7kl3uQ0bfeZadpYqOb8yclr181a+yvnSlX5i2iWp6YI4txnp4c1vIplPJbDGsTlTEfo2kh5guPSZJbYmyNNjui8NA2UVLU0tdmzhsQEG4f4Rxh0iopMFcjsONTMK1cIexqXTCTqg8jbSzjFOtxYt4oraXaXSkLKaQgTtUg8WJP4CRrzBHNli6JSG1l6aVV8OqjYpr11fJZId+x1hijafIj2Yzpo50pa8dyVhMkjXHhsyIY0avo8ZgRopptCjFIqN2OIGhRGOaibgpvmI1a6NVuY9rwoFqs9S2gaU0e8anqNBaxb46z5R3XNKLaqFnmka6Nm9qjIDGJDPHk6pT6KhbT908lL+DmW2YPN6KRWqIQp+7vdeCeWVobltHyn9KYkdg23OitU+adbEZlaBVmoRWMsdwqU5RYJ9BxlGxsVy1Qn6UWaCYh6tqwW2CPH3XMYqvic8s1FAsSjFoVoO/x2nQNoF2cKWHnTUekL20Q2jLlklFYmYljq1rOjmaZ8thfWelhR2WV6l9W2a5r4qtuWhQlFE6oXMvTK1srpaSR61njBwpnbu6t1hggHOXr3azsFhQz8QxYjhFd4WFZM2rxJVHsHdcc4Ftn8aIQT+0nI3NyY1Zl1hAX7ideruDNa6OW26Dr6+hx2C5M27YL2tZr7t5kbJ4ZZJbnGWGkV4ybps4nDmWl12bWc00fbc4dJ3ZlVI/xFxSeIJuKphmy0NZYNR1vGtMk7JHbF2GSKy4Pc3KSc1SgJQpkVeXvYJcc7uPSlJPbjp9soSMpbyTja4zXNmWsDrfhYq4I7JiUFdpYH9IZjOvWYuDTSBZNb6UaEqekYW+XF5zVKl8RrcgU3O5WmaTbMCCon67o1a4aTVKs7W0W3c3KlbGuWd2ibnES2qYsXhFzchmNItfO2tjosRKRsvXMFU9MV6gnJurcSioVZBbzju4LXWVnWSosZh5a1a5dSkvupXPerV7pzuTgkgusxWPN8dHc2N4w90pppo5WG2YU7Fld0+GOceyv21hT49Pjr2ThT60cDdEYWFXOkWIXIWxY76wtjuitoqjjHK0w4mJdLZYpdlLvZNWu36doyhxWuFbvYzCfmaBTXyRMEpgoKZtoUG6Yq+goqFNnquYo5yIx4l/TIB5QbBYr5lSvTwnZVtJo3y/oX1ZyNCYX2d7do56dq9MormAgXWJrkbYRSxytq58TpmbiU92gGkiNLnEdXigVe2/kH3WLlRGsxONU3dGclisl2Kzd1q2kiOlHFxkPYLLQl2tpHew1ElbyEgzKcpKkJ0od1Vagpk/xstmMEuVhJxPL6Q8d1ybrpk7niucdj1vlSuqcVm1e7pA3kxbgqs/QSxsi0dXPcGtiZuhn8F5pJlAY2AzcmLBfqSg2jFURqVM2V5sSXm1o7ikSm89z51VRXxnn4M4Ir7GJzuItU59xVYsMKrIpWg4w2mPz1yKN8hPOTuigF16T6JncJ/NWJE8p11vLsCwkDi/47CaVHmViIZWeqdfhlVrmHxJZ1Vtty2PMadld2+OxVOVxajDy11rRbW6h4e1Q4Rfr4Y2e0S0uXRnRUnUvF5hW8IrV7xZv4XTYsZKurwipZWCdrt2zqdsRTnL13IlQU6tuR2Vl52tTsjSa8taS8epw3SvpMhDdZ3PKZl6hGp+Mnh1hsqgG1lTjYd2OoOKPVZluDhsSD23Y1fQz2NUrYHJNnFPqjl3eDidTmQ5g32qUUPh3DmmZjRlUX83JnTWhDd1xnqmb3qRyTAtjnZwgCNOG12AvnFaWcMgtLJfKIFL0EnVyLktI8+fT4ejomZTmiao04JlgKiUdlssyUC0r4KhRtM0RnXgqVJ+Pstz6tNjs3ZwcVnIyFwyZ43IrXFePJubhbU1l4KdzLtYTZV0T0872FFARq1zh0pIqY84UdGjqshzgjF/t4V9tJV8YFrBd4ynrrF8ilppgY9RmoR1QU3cbDJF1bvMp2GWe1uafZC3fEA9nDXaf8aQXzeN4plulSo8fkViVbhIoycvmjWzt3OMOk3Nl6xXa3Y6qj96o6leeh2jYXZ8Uc5nwJ1JrCzVioCDcHGhLZtHgpo4gdpMTHd3izlRjYTAxHbUvHeZlRhAraWYZI91xcpoTWgysrOgemaHgIFUWqGsTrC4QpS9ireaJ7myVFJkpVTJXkXEpS1OepCKuXKzQM67c8nHTrJ7coPAMWyBdjyCc3aKcMGCT4CskLgbhZ6yYjOblnwricUtj8K1QCxLg5BTWndv0JWlQjVyT4fFKzcpmUPAnJ0XuUGyx2Q7Ik+RQl60pDRuMTrKyoCNl85mnnNW0GFyK17ILklPZYkhNGhrsXpDiW0u0maSqq9jocC/vJuJwjSXvdpYsbo/PTo/u443T0vKQi7VLLiUQVWBZFQ+1G+fp63BsVdJMX9brnXEx0OQqamuui3F1Yi3a6N7W7qgN5xMsm6AmYyCbLE/eqORNkC4Jb+Uwj+gbp6uZorGTYCALlB6t8lgPDI/xn6OKyVDWmmgUEeCvc/MYqe81F2kO3GNum+tPFaLw6NtVbFewuGGyI45aHK9boWptoaCZ4MuRYvFZFLE69OFjJ9mmdFFilhES3vRoy57OY2SO8WdzrtjYdBShX2JtmB6HSybtrxDtUysg6UszU3YL2M3Znt8N84ssbLEg2Rzt0BHmrekaS1YczMxvXCuTn+bXY81w04y0Bd1l22LlZ90b3A/qW61zzHDx8GvQoeMml69RTFlc6mbjbh0eKBpmm5GOECjzcExQGPLhEtT3kdSa3B3UW5OZT2pxIihj5+5qYVCK1JZps+ChlO1vo6hOmjTUSlwnoyNp6i9ZGKslISNmE17V2O8OUKzjI/Bgjpdrj1qUYq1ZiGhM1lxkqC8IrF2zVOONrJitrFio4nCO1bPhziCI3tInjGDpmGFtJvNLmW7jE6ZoX2QtlFpgT132GKGU5ynj2OEmVtrqG6CqnzFi2G0jUTLwYIzzDSbdjFLX1+ZlCdRVGNUcrCBWF6bjyaDVMapI80+1HcwoHUx16hEf8xPgEp3b4XGX6B6NX51wj22vN/PwThubNagbNBli6Ogk8RvRcZUpbCXLsqMTnXVUb9qYl6SjMUxTjNrVm1sth9/Q1OxfZElzWuNIsC9W4wiV7GaOYMpmF2aybl9YuF3NFptN6CSmS1UwrdqiSjFU0fNb0GsPKas2cd6R6KEnzGsRUvl2VSMY2yblW1DSZte0HFDQ31hSFxcv567c3tTxna70h5JrHaqmFanoZlYwFBKlGWRUqlW4DoxdIXEbINsPryixJW/OnM23z04hoq+gqE+n1akwlYwibA/VC7XaJhUjq1tv8/ARFiohqE3y3+2kk2DTHi71HnQ2sHONI05xKVqs5vf3pSbRqt1WcViVEFx1K17dj4mfYOQvzmdHJmFhco7ecUeN8WurlKEa65PMM9JX043iXhDv1pI5EuzW5pwsfSCS2yxbmpJvkQjpkCzdIQ+Z3WHmaB5Yphgc6q2YLavp1e8m0MnKrabTk15cWnV1SNhMF58m3tduUXNb2BNuSotPa1yOGpYcr5WhMOrLaTtUrOJqieoqbSpfrVAacQzj3NwsFBRcMF1SkW0dV9emtSge5lGNneSeaTIXmZzosetTWp9jHkzU3iqnE8onlFqw017YhyXuqTOZ0CapMuOi5t4r3Rsda2HQi+sfILTZDejaKJSyNV8p7FwdnGEjFBfUX+siG5jvFNAdrLcfDerlFqrvFyPo0zFXzWYl7ssX74uTaGmmJppM2MUvMU6x8STqbgvNMxIoCW3Sqd7nzud115USF6peGKEVaNkxZZPiJzTWEXZuMORNpeNooBaOKiYn4B/l8E4QiXCdiQsXnKReYxYhmJpWqaZYpQ6Pqlgq1wwrzZhR9N5tkSIOTxJeV1RQzfPb2RVwkqJhGq6UZ+DJTFfSYCLULCVN2lwYIg61SuwqLdsi78zd4y4nJhVotEsP3I3b5tCe4Zgl0G9x6VetHFllU8vXX+zwcp1y11Vd7tjLVdIaTe1Vm5PwjWIQ9rWfV3MRIiphMqzTjFYwHXNgr+UMGvSvIh/hY+bibuqNZ+VkoqeNH2FdHJipW64OLFct2ynek+pWDuGenC6x7d3zy/FekKhu9OkL7txwW85r4d2ZVB8VmRYhz/GY4+gy661h8Z3mlsjPbQvppGKQ8Zbe8YkqaimhXZQkbZhXNs5dTnaf6bDK7TJlFmob05K0DuecJRBsoYtymtxcZN7S0ye33ueVkucjV16yDrlR2VrczmIqJ4wtUatYIPJWz50XK+vj4cmgrPNrbaqMql4Xj+NWIyzoXevW45gghuOs8VotYxfu2V2a4uhaIbIrpqpc4HSs0pFnFjTgb3Nyny1cjPMOIvGVNBanGSJfi9UMDvXdUxPSbvBHqzDKmG3dDZKvTQmcp7OeGpvYORbPKCgX1Cacb3GxIm3fzWNlaY5nkOQHow9NqhiumNkyJ+iRtSHMWYrZcZTr7JcuEKvNFd2x2uhvJajclxBuS+LMYWvcrJfbZJDt2/Jm5drydeAni53wsrOr1KEoJGGqt1MaVEwZKU1MMdDVIHMpD1bm32MXKOId114p3yPprBGV0gefI9ipzNWSI9Chimuo1tzHkuTm6gkl08YR62qSonFLKlPtF5XqpOZhql3fXhGX3R/YBmJfklAzbI7aJCVhV1TzZgzuKnOamLLiXdEt65LdUCxWXma3CtpaWdKYVtvTT+MezSVOK1bVCXTfYZ0kWabkjpbOqg7pTRhbCPFq7bSPLJ5pluJaa0/rpm0OlY2Q8+xPUpuzKV5h8GdbM9Rg85yYoKnTq/b02dr5ZZ5NK9FUc5+0ipJV4fUX4TAI2+KtKaFfDhCihyOdK98KSnJRbG5pm9GNEtKnJpoaY25rFg1nYUub8RUnpy4fqFgUdLCqZXEv5IgiYw7gDqtnshBbxtLMTm5U0WcaHi4rR+7rraaXGFDdVTFg71LeqmoQE5mW2xDLtJZPNVc4Ec+o3hwoGNQxZi7T9mXLb3FUl0ogXXQKabeRjOLrzfRkEgsOIyFvj6LWZDFR1DFXIhmdEwzw3SbsnmYVZiwVmaTXSykJ8E9b1mJuWaQwju2YtRQpUF6Mq/cWEWRMTd7NoFMR1Ofdi2/wbIjcLY/h75Op6hXTTjQy6ypPIDIPN8zjYioiNU7k7OvW36+ak6Ccz9jrqCqlqigajjgO7ZRbpcuZD8wfNaGMVWfirA4UGjNPaFJTW0/ZY2C1bQhhLVFKcpxscBNuBa4blNZ1tljlYOjn5+TTUwkurtMaLeDyclilWR/yLCilZUMkZK1wm6Ob7wrqIFWxDKzd6qaSl+sXnhfx3HJWbl1YGkpx2YYV0vUwt65o1lyQ6wsfziBfT+Fd6NSgICaomxAe0y/Y9UoRUw7bKGWXWPNfIOcIKzFhWhIn4ZFdVtKyFmrezbAUDeqWrXMk3JtZUwmuJCJli8YwlNMg63TPLFHV0uIjy6ZTX81rMjCh2i+jCk+TNdxUW0wOZbapahlO5fEem1DY0IuMMhLeYmRLZyhg7MdhkJhLqGslK9WwmqPgJGiKqtwaHC4bqppro5HatfMkim0cKSInpjDpIuRpDcksJkutYipTWlgvyy2OpJeuzOkeLCU1DhWXI1+LMuio9u0OI9DuEhZrDJFuTuOhD6dm64sQ5PDQqI6xVrQt6OteXGgRGRJTj1hKne5oblTRz9AhqA+MjKtMj4nv5nMMYxNrEZbgzObn3a75kU/RGNMrol5dmnM1sGCV5GqW7RfUm90eGmCQkrKpCIuuU9SKqdpUH87ylimWj66bi9/fsR+PEOrsZh3pFOShnSqOzyHZVw9qE+Fc0g/w1LSOG9YkkKIR7GpqXgvTWmizXCMhUpaQ4diTktFqlJocqc8pWi5y5TTUz9/VbvXUoVIObw7uMyLy6uGkJfFwlKXjWmlKctHm1mdgrR7YGvQ4HJKZbXFq4+GJE91yYaNQDWD1bGqVK1eXp5qlLQgZb19GpiXqo13TZtNdSuixo0+hTlLaMxQgW61tNBgj7ZLNTyUKCaGtrqkNVq9Z22bTmOjmaRAOb3WnohwdU51VYJAjbaNMpM8YoOgoEuqMb/Mf64liUbNQ27JcEykhpJxeKywl0FqMr1XWKecY3OltEevSZJN1X1eoz1jq3Z+cz0pmpxeVVhYLI5Jh12rXkBgK7WKQ8FfS1Va19xHQ1y9ykFSs5JZjZFzqipKzH0vv06ecMVLSktFPc4jg7+Bn89HX0ukOZW7l0BrOsJXREp6hruDo4FR2YoweWQ5lEqjVJ13N7VsX60snaeUNI+8T1Pg5tVcu8pNIJhwcDhItcmNlV1Hu1Ciu4ZuqTe5rdEto8QwL8Euaihj2Us9cK97eiyhLIqiqZSarcOnXpuwU3Vyy0AjvYRryqwpnYedR7STKTbFo55VaougWIxhgm+qfKyFb5x9Qa9z4UCwuLrWxD5ZoomZp6dLgSmnydLONTuJsJWQwrSqcGY/oHXNMLgWf66Up7SykDyVcJ+AdXyyisRfS0hk0s43kI2BR0hNcTl6lr+Nd1sinoKyToKslICfRasxdaubyomfVjKTPnbQtli7pJPOUmVttMhDlj7Kdj0kn7R6xkJAhp5Hi1GUOlOwrHn/XUA+QkG+wT2Vua4om3hVpEJ/fOZM0ZNqxZkVs7yAu0avU2yuyC96caGKnJqNdXRfMKSom4QsOs3QKqp2sn5EpJnCxG5NorkrYXmeVNRGpzp42oCxTXdQs42OVXJjmiOxtJZbppO8kIo7sy5LpHm3X42WwT1ZLIB2a6VJk3uJn0Ntn6eWuqtZhacftEyVWbM+nhuGrG2vl5/cuUtfvqQ2bKDKYIEydal+dbpUaXjOvbaFi0lNl3PFx2lXpoTp15xOQ7SGbDJexbtJgsydxZB6IoqfIxvOg89CrE4hmJy9VGZPRMS9lKJDIihQe6KxlLtfc0g5ZkmKsmVXJNRRUUNmS12KlFOgRYtjl1U9003WSUKaTNBmWlZcpHdoPJRdX5O3m1B2hUW2w3VOQZ5UYsHJuWBxsLN6zjFacKGS2CmZVl9sxzUnrkTCNECYgEWb40+az5qltHmXlz9cziORaGmrzjx0Lm2ks2DblEQosLpBmofHfz2NiHdbxnB0MrdUH6FCiZxxmqBHb2p1zLJiZJtkmLSyWZ/Mc8TQySavoRZcgrR3S5t6eOKyv8Yyjzeojc9leLhFZo1H339V0j+S1GQwmpmCnYSCpNMzOdTDXrg0rH5iq5qNcLqmH167do9WOlcuasqkpK9Bol1dMJCRJh65r4Fjbr7LXlkojL1mrTOKa7hmhGSsLH1GwY41ulatuGzactSVU25PNUp9YVObjHeHuJswkzOlm7yqHcZEYyGCgKRtyoZarnfRLMZyXZdzrFDJtEqeg0eyrqDMXphqXYRpqzyjhzo5qdbJQ6+Bp4ewhS6vvJO4VLjAeJWsnZdgKqpxQC9zOtRdjkrNnm2vUo7FPm7gUE2oXK5xdL9Esoy5UsKypXitwy480UZn1cynsilabs3Xn2REr1ZJo46FztNpZThrTKJmlyeppCk/ik6Ukj/OVHOaz4uAeKpPmLbYQ8q3f5mutFTcPeE/VdEww6qUXLmJrHm/US2xja/JbD3FUyeIUmifYpI0eq7UmGWnsJ+yw4fBodmwd8GuxG9vhXJjSm/drJgsjTden7J6xFNwYs7WNWxUuleRhI+SMK+XYqiwWESDpmk1aE7XVrNKe6uodbO7j3V7uLi1NIWnj5cxwiZcVq1lYpItUGO/iaNLmrjDJM2gjGmCj7DSJq4kqkobJT9oftpUi8FHzEKVs7GwUn2kcqWBb6I6xm2Ov0aMfMJUfWJvLFhkKlhmdGFwSTmXX6wnf71hpIJkikNQezqCLZCydKPOljXRgcOYnSfXyHcwhTqnRTNUZmmlRo3XOnuGw3coOa6rSD45paxiN87OOXVsOEp6uLaqP4hYkmVHuqd9iEo7qpppaZOPvLSt4WZI8oqZYao4YqZq3y/Yh9Z0hWeDPk09pDyTU9VVkb871mozz0ixN6Asy5hBe0q1e5YaqaSKOWjBcm8pj4PJpnlGca6DdomUUFGlRcm4amS1a4pl2rPGzy8yhIePaEmGd5dWxHjKvjnBO2N/p0lBv8Oxhz6UslCMXM/XUVPJQ4pUatlLXWJMQl3CWdeEa2hsJGXAnyi7vlNtLJ9Be8haQsKsWHmiWXcv19pKl78lhzE9nKljVKPaOKa1wLofZ594eTpQzGOIg7yIobUsOkBLXXY6jKTGgpypsHvDQzaHvT9/hH2MojjMTzaNoaRQ1liUsn2TtECURnlgpnmsh4+YPzi5V0xteYUoTGUwhcXPmi9zUUx1RIBhykOYq6l9OZC4Mdo0iE+DIZMjXmZf0T2TsCa8NTmmqlyAjDePqMllo5PGH6qcsKGvKIVMU3gsWGJMyVm9jah5l3XQ1E9rYb7JjTl3mmmOSowno9jYJlOcLGyvU3VniGm3Yy6PNZVeZLy3P1qngbk2k3xCeLVJcX56zUxHUciFOL9/sdViqoiVqcm+LD9YVksuWdV0S1lTiH2acY90x3nLUZt9LWw2novCJJM+QL4YRbyWYKGdi403Yie3v5qytJWIamaclWV3bm+pbaykV0tMjtuMb1FmhorWflgvp7KHh3qvU13AZ365USt+P1dBRoJiLY6cfGY9SHRFQIlpkr+U3kDNtcZ/R8xXUjZFgmjDaJhbvsucLF7Cuatme36MwL1QckN7SISGhbpFZDiFe12uKUuBUqFgcmSqO3etic5FKZh1XlZJMpGAO8ZFksHHTGiKmSJUe5Uesb5TOTyLcoTJV9pwepZgRUK1Z2tTl87Eq1o8N31AlWfdSz/dSYNOvL0rNWFp0o42L9cqz8VBbcxMZy41UzS7xaNwVJNA1C18Ra9DvTN7gCNHmHloxtVVKrVQwUeJXT3Di1+9i3RPMIySPCs1sThRWq25a62AfaMpuYF2PVHMRbxafL+3QVZRg6KHmJOVnWfIuFPXj55rl5KTm3s4kXt9XraExJBFauhc1zJpZJyCqNe1rGVJrZOgxY1Db7PBpsWoscBuSE9ZoHx9Z5qHzJdRcWGMZaw6wh26ZTOZZaVae3/BaG56pk9Sb2wkT9W2hjCxXaVJImWSPlKdS09eQGKtzEjNxZKryL6kUC2mhU6RgR+jKXIzF2+jt6KjSMJqR4RnZ3RwRjHPRbuFfW9Fs1V+RXNtuqHWrMGAOpHeUGBWoyyRtL5HS4OEuTJ7OY3XNYZLL5BOmMdLk7yNlLmRWsSoS1hnzWGxqW2bPH+6X89IlaZDpMiPsyCFnbl7V086ZHxvonSgfEJctFmewEurpGiamlRCL5Nxu10ntpdNVcfC1JtCfnbFajqIOU1tSYNhczmzh4k7QZhv0HBQd0hqOdJkMUaTyqqzP5FnJay6une3bYB8Tcibw2C0sKpeWdI6f2JEI2hyQzqq4JAspVC/f56qdKR9kTJgQnQ8LlVo0Z1mo0OlIpu9ZF2VedWxpz/NVaRvxZN0O4aFZHinTKyleDTCr905Y0F0g20+hEVZ1VaEd1tjMXGBMchAaI92rF2nrJu3Um1wXIWvlaW/lmM+hLOWYl7LWKp42FWuWV64X7mgQTiK1WhIjoWVwKA/ab2a1Y7SLMgoR5FeclyYbFqpo14lUJ5aKF2mhc/Dd400LYBWvSJnu1ZuY3qrmG84Q66ogm2kN7w9sU+MVq2TTh8ngivQgZRZVT7AWjJ1MLaPV2h9jVBYU1mAic5FrdJHRTKZPEmJbbBHvHyHk1NUsoB6hZitZWZQv6XCTlVqp2fjV9Q2NMFcuB/DvaW8Z82JuIYymTJpnW+9GJyvgbKuas6GzHaUmUecha6NtI6IgjwiOqHDVKG0Lph42licW48plV6KwGVOYSW1z6rAL2Fyvmt6L4m5wJB1irKAlnedY2STW0XGbsScdpi4hn9VeKKhhWw8uSYndHkonqQzJX93m65PnFUwf61vSF2rTjhFpYCUT9p3V2m3jcaxHYW/QSxvUV093TipSMnFJ1ZIiifIxLm7Y1V5vFOMuntXNqVcqT5YVkO6jKczbIrQkFGGbVRCxzhWX6NqdRzEG553or01j22AYDdOWn9DX4UrMNI2SsNIWMxE0q2mfXmBeaCIejk7Q4jLgCtcibCCTMpRuH0eIXCXPW6rj5G7tXJHQLleT5xOx2KeXDWajKdZzX6ptng33kOVO6E42E9VjVxqkZWMZl+wcquGpTjRS7GaYMaIn1dJk3R/e3Rlz3R9rMl0QGXWSkmle4DIcozJOVs0Q3iVoVKTZlqHnbU5QKhVYrqiQoajKmqjlkxjMcybmmF0fS/IbcaBsFaiIrOLpl+CSqSehpqSPHlewUd+kJ5Fyq4prnrPPX1rmEpwPVGlT97Eaz6Xt4NyljtzPlauL0ivzarQhbBVpqpPGVCUaZg5knSBfJiMw9dxfa+cQz9yqHl8iogp1CtstK9xm0uuUWuoym9PQjyOdZg6mLgpqNN6UXi3bzpGf8RnGbicFLwXjXIkMcNJUHcxyTLYrXglrZiPwDucLXc5ltCtu0x4vFNifB+fVVZOSI/eLjV/co26plM6u0ydTMa7z3TMNEPFdTiDczdub5JhdT9+bYTENrm+cNWKPKrQnI2AzYaxnauoQyasUDWNUHF4pVHNLH0rs4O3qzXHgXuYMI2zfMStOJhhqH2aqL+BNsSmeVh0y2jOwK6MpkTBhZF5T1xHipBpY08zkdXPl4t3xCjQoFp6PayleUKYnXCXvTwyu6+UqX5kSsMtfblAprHFk7lGSYGTYl92iHh5t24uc73FKXejWT6QkW+4KbpBuJaeSMRPkmVHrqynmKZphpnGu2OdzjS3q2veu1JRWV2xRmav1D5SinompV5YlbNSjsOHmlRjcNTOj2/Cw7GkL4tnuKWFl3hHeValXL1kqMesn75tgZM8UXGAW3qsWEmz3GiwcYZMe83OWmqeNNJqGaOOOWhyaoW/Q36EYji8Y7Ixz2CinWCvmWOClSaOLYHLYGEsun/LtbocZ2pj3XCs2ZB7eSe/TVc/NX2TcIpsgo+4al9GN65tQNldkrXcUsK8kx6tmJhrqX82xlaanp/Tga2LhCnBnXeAutc4dEZh2mNFSVGDlSpojUZ+RE7RzmFzWJerwlOdYW+sf5yCdXpD8lV/bdg4yyBp1TYxy6WIMVyRlVVysruEjrWQcCaXscc+3Febp5VOjalPZzCOVWLa3bR6gGiVYnhNx8FLxGuRftdfpG3Dpp47bWJ6poo+N7adlypUmzmBmJXCcstvqjTCutLWT0WliYGdPiZCNmY7bSOczDlev8xKur1vT3fVOLtJiaGrq1WsdMgYslOpo2g9nJqagSQ1e6eIgCerRBirnSx8QHxQwcYzh1vaLCOttpzASClYnVi/Z48nnp/Xu23SMl2OQ7Nrcmi8vK920ajKv8m8NLmVmVeSkmOnXnOTZ0efaHhJhmvDqq1hRCx/sabgSpqidLG4v42Un5BfP2RIXr1VeG63Qda+yWWgKsq8aqFxgFqMK0pIZD6uIMhtMnhIk7I5Z3i1W8E3oWRiiMGjSm0tsqhmd8+QX8pmQDC8jl1NNbiLeqxbMoPVXkSMOpGAsiObWLZKfFFlxFFywsQkyipVUlCZRpajSJ1ElbY6cToyvXmtq2+krmWqxFdNPKNjiHNVSzvYYKVAZpSOuIqFx5uzujd/unqckz+JRi5ATsw/i3k1OMBrcs88r19DfVp0lZh3NjB6sbbRdpo/NXS/F6JwwXVKmnK8LrYmrVOuTlZVNUnLS7N7e81EgLRniVCaf9GwX163v3mlUr2McH28T5t5Why7xB9yvYrKZ7KeeWY/2k69p1s2n4hfTnpAmaLMpWiElaE/UYQxmrWhLpWrL6O0bTVDm7Z0yohxiaJ1jjtquZtty1JZP9bYXcOmi56kejp92XdrrE6Gq1lUVLXIXmORvklVaYoxlqVhTG5iSkY1r7EhqZtOabucuYCXUX3EjDV8hCsjmMwtvi17vnxgQNBJn4TVUISRq4Z8MJezqDe6015amatQgWyouGKEmsOwYk+uTTmyVGQ3PNq2t8JxYXxAYkitSrCUgnHKhFY1Znmuw1mXqqi5ozRsL2t1dJgvyrEukp9eNcOlTZI0ux6sZCnGocCyotCffL1JPKfFwTRaQmVxmpW/XIlQjke3qFbCvCbBJsTbXTpTOVVvy8VFuCpzwFHIM4JLumJIuiXHZJDIMXQuy8C/HYu4VyyeJE7MZlJvukGGq8J8EhHCgzXNdqnNdc0xQrdqnmekskNXsZuFbFGRaFl2hLixpTx7OrdIZ0WqrHJtd0zOLGmO3ZVnyMp6hqZBdo5pkKaqOXpcQ3mePr9v2E6gm0c7e12AN9R2l5hSpTA4oHO7pso5UNDYPmZMnsOOxVen13VCfLiOxLtSy06h352nV2R/YHGdGoOvg4UzHMGlukrGzCOqlVJESks1MmSYbq9Enpk2l1xWY2J5j65ovpk0kT+VNDHaUY8/pjWlnUmjijelbSuFZYKCgkCkO0pjsqJJT5HlgmzMX0azgtWLv248uYJBI61/QlZSbr+WR7M/SYNAZGaZRYxFssBrfEWcXDw8gkMqqDS+qr4ymKKZR07CO2dDotSgfkG1knlTeKE3qTN1sh2RuJSxZkWVoMpAZ6ZoIdJDd4vUVZCRXb9qUbexnigoQZ7ZVHvRP8htw1w+SKibb6SpOL5ueENiz0+2n2tzV6sOr7k7Wz2Ju8XLQK19pzqWk4dXSjU5ScpZ4JPHoi7AnKbKW6VoV647dreWqZ91nIG0eTNAjSF2a4uoo5aweFVxP7PLf4O1gCssYEumPlxxpXiqYdaVe8JHgbMzfIwdTKK/yLBdsrChnpy2Pp+zUmB+faM2QzurkXO8xXkoXKWnhboyT86HxWRLyaZIlHHFf1FpWIxylIGYdzhcr0WAkjiZfJqqnWxXJ5SPraqaUuQ6UItXsodTvmBBQpSIWVinhWBgZWVHkEpdz818lHw6VL52XEDXW2zFVLuLv7aBuLoQxq7NzGVtXW3aWWFXa4WcUluhopguUHgvYTyO2MbWNkRAMVhR14aapGmRsMVikinDbVSRaTx5bUCZqq1Udblrbk7KOFcvrLJ1ucSVdUiTuHIkXKVTQmvZpVXH0Gm0SMObeCiDqXW+pNhkOaS5xVPLOWvZsjVONdiajKhqlj8ibLovRp5nYT0744CaeGR00WV4T6SlOEywYSubvqF8lCuLt8WdiLtCaMuhPGNBdGbeQF99ksBUpElohXU0vk/AmzuXNDJSoISDqTNTge9Tg0glyDxUTdVfqp0agDaZdntweJbGSpMzWrG0lm3EO32BYVeEJthJoIM+biijdDiUPGKvsLaHmEpAcLOnUqpWP3mGwKBxXG68SsQzyDJxlGN8iZJ7T2JFrcU2nDl0qmLGwXRL5G50UVBN0MrTmHVLfcmBFK9dvB5uQ5Vwe8uVJigxWUo8ZbagUUJCuWspnlQkRYiNN5CfhVZtm3ItwpechnfBj7+YvmpE0Fk12GZLaUU+p3W5ul09osp/KLtlizmUTURrmVifONihP6C0R4J/mLNq0CvMSJyCZkDEdU4si1SiMI9ohCHI1KDDMWu9MMPAUVtTaIp9f6OdqqrGIChnN1rg01J2aXt6JZRXtpwyRoNZrzribm+zjoKDySPA0IG7JbNrlH3XV7puRYJWsBazfRiAHRxPxcCrRNJhrr6/hTVDaovqV9LI0DnMUmpgMVeLlC4+KpycpM1WWZZ3MT6tRcCvLZV4VdeCX2+ZrWpnpo5XfZp5P1q4SZaIU0WyyYEySpRwYrI3rJ2ANdnd0TtoedpmXX64vp9/zkRwvVBUPHJ5UMS/gK5tneg2Q019nnpTqctsYKiijJ2WzG+KsCKatF/Il81mV2NyjbAuix07hYi/KIspSbubPMdKzKRxX5W1ulS60KBsh8ydaTxIskxQZLzXV8fTt1igTtQ4QIpcrm/Xk5uLwDx0rb1IY8ygr82UkJGoN2Kfu5OfwpIoZsxYrJyIjTKXLp2yr3GGn56s0EChkJozzFPJxF2Qm6w5iEpBYVeKSl0gp8I1spifaJvQJ217Qr9oWl3KpcyJKmyZUNZ6PD9Bq3W7koFjNlprbZXNJrpZfx+3pJxZM4yUYxe1ZsBFN7M3b7RdhSmHOZxqqZI5sTpoXXxbl6Mw3Wm4bSpokL+lQy1FaDy4k3qLZrs5SWNPvERpYydXRaOTjiYkSH1pnXTAUa6cU4iLHmrMKFBTn1LIUW26e3vHcCfL1T41lzWTmtfRlI13wavCnE2XUm1LnbEltpe0aaIkGjorusVuWkRK1MJvslXVp4aFs4w6jd3MmknLV3w2sqebz6g1kSJAjEiRlNBEkkZ7uFY3fydw0F9Ml197YX9Jn0qwncSRZMhYNbeaV+HNoyW6z0yAgoG50NFEQL/N3aGbgZjCKkpKr0HGrsR3a3Q4yCiZXTpRs9VbPj/S1q5oo6WPqE08boApv3DGoXxhmVOC01JQqz/lTzM5N2uTcx00vHNDVHw4YSiitS2EemKn6Ugvan6Nn4Ofpz4zV1iQNtJ80CmomMkpfIsxaklywJI6Zltci5G3vl1INNKgsog+brzQNDzWOdiddzwzSc1jhVO4QzOZs6hReYZNrMGzQIRrXZZTQ4RiyYBzy2azOUeBrDQ1ntYvPsRWpi2du0xxScJzV2RjryvOtHGIkTGLy3y5bXBwIpZ2YdetOio4aD/KJG1ui2yKpM1TZnqfxFvEOngqLMBOgmqkr69QYMW0yK57abRnmaA8mGBBimqNVbOhp4STNcdzQF+SnCR+hZkWmoekO0ppkJFhYVnLoai25c98dsDD3MNwfInSiMOrvpajzX1ojFuWbigcpkUfz2eKhzVMSX+9zj56tJu6y3KrJzGBXr64ep9ko2YvuV/casiJcKLKnZB3XXfKl9Quh02qhGe/dmifdujOaIqCiXV+cSqRNa2rSpy5n08irLO0ITJqPr28aYvMsj+oRqSpey2UZkg2qmG8okBg0Llaj1JVpqaJOG+HjEmpU1bCNlN1t8yILXVhbH2OYkvLb8l/uSrIIkY6tK+HsjtWwVile2VMgWtRZ0/GuMJ/JiyEhc6AzntRNnYxmXdZVa2ajKhLU3/VnmDFoEy3RmBbs+RUYNBQundYW7SWcU5FRr7SwKdOk8fCN7Q9a42xZpl5YV2ak72GkL5kI8AvaZte07o8wctIhm+hXZ/BxISzNXxjuHnCkHti3DfWezaIlCujycGOpD2WrJ64ab9mI4bPkpcwZlaIq7w/dHPieEw8ZWfRv16ZLrOSRKLLu5i7al7ANMB/fmR9PFvWWT6hVlNSlleCICUxqoXXRViQNTy+asulzTyuaFpZm61UxkotY1FAcNwxa5HSpXeeu4ZNYFaSPz7Ee6+mt75BsGNKvd1hbTvBRGCaYnSau1krmWFqO5E9xlVrjzGjY02iiUWmcJGqbUN+irpTgWdBSl2TfHO3fIhAsryioUu/cGG0scm8wUtut41keWCGXUOcNl5/e2Q5kLaQdj490m1pO4rBSkS6cJuRN2VetLuNcC57mER9w845njK7cl+3TTHVT8ZiaJMqt6ypqp9BQkZsunQ0vLVoXOFSiLtUoW9fZrzAYE1AaF2ErkOUJjg6m1Q2rD17hJtljJ7Cf0s4YK6Har3NdlIqQqJWxD48wk3KwqEkTK63qHnETiqqXopdqWSeP3B217EzvI2xpS7LODpitVmQkKlQ111KjyF6xJphVqS2gmE6GmhJk41mr2wwchsYvq+gxUJhIE6ZtzyjJktIUDnBSm3LV9NgSp0wczlwXYh5oHwsza85a33NSZQlUKBaIGt/gqLWJoU0dH8jNIVavyR1jFOyXEygQ1qovL82QK5VuMW6Wj5WkFbib3NJdbx2QnrEjyOMiqZdqDRcuEyUf8dpc7pcTTG8hHKMfDnRxTyrpq6eJoFZW5HMLFjTxDyClk1AQZysIouPyzCTl58ryD21qVEmiVGuKlLeYV1Ocq9c1bDMUdzJ070wvpymYHrLUpp+tpF7XF6Ff3OAaWODinWjMNfliJlMzdJdhSRPdxy3V6RS017ZU02NJcVufDZYgKdmPz2zw7uzXc4fXhdmkY9MrT3EukTVclmXRGdBXEq6gEUtRceOhJuqoJyJZ4CqRtpwQsyDvCohg3p9dMYzMo+7qsNSljlhkFe0p9pOkoiSd8uvUVGPWTlfyUjCOSVAsY/LVYC8vFqHX1fes0Zmxl6zpXNheqSGbV9agqHNz2wwQl6Qt7tYvcRsU2VVPJ08kbUrT2mYUzpff09xN39qtz9+cq+rTWbEdmTGx5lVQLZdqDqPnotDR7i2k7ZQmV1wiiVd05bA1eJFaHC5yzSeSmFUV26canShOZ5XksyTSlVRP8NCnVtYoHm8lFnNN7eQi2evXtd9Rzt2vlzBT02LZo6vOGe2VrC5r7dOY06HM7A9laSxWpB4on/Fb7hQko6CLM6DnzeFRTR5eHtF0pubVSuisFa+PHcwNsxgsSyHf66QN3K91kDRYDuBoppisG+6ta1BqL49d37Hp6JUJWq2Z0jDdMDCUKtTUC5PXLVcbWNVvrJWbyqtn52+s0nONy85gCWAOqpFW4hBNnnpTThOqaxQdFg2QqXFlpNRip0uM4xneZzWyFlpcHqEyCqWe0mHfn3MfzZzoKNEhF7X3Ey2XjlUhaBdRnsvq4JLu9jBUcWJL3NDSJQ/v1dnR6+qi2ZNV9Jybjh0kKTCRpVgpXdOT4S+npDcWaqmlLd7ubpuzKc9s6VEfaVcuYDB1l52tcTKgtRmgmqDxUCGbI6bZtYv1Ha4X1BHsY28TBtqkGiheYtDycnAIVNWhoQ+Y0d7yMxnLl22b9Iob42uVG8yaGdknM1Sg2d5cnedul2yoVq9QNJkn6OwUVZmssi7cuh/YVWp0E6yyDeGNFaBtp0+0zNMhz66u10zdXGHH5WxJoWviYpEZmMnt5uHW1al2GlrqIZdh822my/YSTm/gnN0f6IoqZqeclOydEzBUFzPvix0obJXqX9VWU6LVHVNhEiKkKthRbuvk4NyuhQ3e8gtpo3LPjpYf0zGl4R8RFZnVjjPx2y7hLi9vpi1P5+2h6w6dr9SXJq6JK9klk59XDM7nbi4mX6KkmYow7tynGydomZXbdGQY8l11W1FUtScf2K/RsmynqJGzzdY0mijWVS8uq5SzKqPtUmmvzQ1txqTgr2RXmCtM8MeLba9lJQ8aZQ4i6VCPVG1zmyuyGIoXEaHxY2KhqenbCFAkYq2LFa36FDHUZyMxHhaq5A6vGV6iE9zZWRzlMFdi3VUcK64dHKqITXGeKFmg3C1UE9MP0tDlUVdqS7FX1h8jEjENMmKOblgbcnHjGe7hlIyTVVax6zLUjVLk49Eb4GmzCuDdoGsfVdyX8+FKku1QoJBd3LRs4c8Q4tj1FNdhT7bRUGMVitSwVJ+LStbwVqYRaI6izApxaBdpLimjEubx8I3elnQRsRyT7JhKqJ+PqSL1JfHa1aod76EuFONNX9u0KduLWDMgmnJcT9TRXmNy8GTxK5Ht65qGh+UbrzKoUlPsVg7j1aYeE1Dto9TtnadUY6tfUZOTmdWiW5tIJ3EVmp4zp+jTttUMdTci6i2eDGILo6uD4aQuXB0wbVl1Ya4k0esQlmyj14yLyG6myefNKlAP4BHU4E9p84nolxZi4Sot6gUNEPHW7aZcJpOlIqmsm5bPFyZZ8PFqEGgdC9foV9ixDEftnKRap/oaFeplIVCftnIW3uLM3Vbaneur1BrY0l9iJtsbWu3s7a5VyadYmx8gsyEVMynr1ZYwr6NT5Y3joGHGx97acqrjnm1U9autHZzhIlntU+Cg2SI539ING+e159Oka1ZYmOsyj1wZblpVK6eJryrLaGfODchoqfJmFOZL7irWcnbgWTEe32vhZhfyi22N9GtZjhqa2ytGI9nnsV2j2tGZ3VlUj2b2KJuaMluqrpsmDe4vZZ9tmejukFPuszFZWxLfmtayFV05MpnmVvBYlOfwJ5YXG6qOYyPnXlWQ7GTV2hUWKGWaW6/PnGEM8qsOi+gL6c3lsJqUmRlb7ulvhdnT7uYO0OnSdhxO3ZxUl5BM9CpOa+/WkVoabufm0OOqT3AXFudtJusXqCHX7qRTYh2Qah3uWGgUU9hd5Y6nmGjT0SvsZdyrThSqaPVTnV1UFYdgH6ju2NLJqujvNO6r4SvsIuvZdIoeis8QSiiXkOmc5M8d1GfQI1Hn02KSspZtlk9nyOfNHxMa7CQNSLLgFjKcsizh5RohUm9PchpZnxISHnHvmm6T1XO0o+nvnqpukiZtY1tpltEe8U4nz+zclu1rJhznaFnxSCeg2OHscGcuXezPJfOaHoyoqtJs5qXmLSpM6nJy4dQMZ7gvFNNVp+qJl+KIa3IwDGQkUacbYnKQadTo4KYnnOHeE2lnHiJdrfAJlFnfW1MJzdWqV/SReGMSKUvUzEos5uTwq1/UqM1tb64RE0vlW1dT50Wp8qnmimvpcljkZuAZ5dAh4aMlxSWtj0yRl93a21RqDuEt41HS5CLm0S/ZkmDMUKdb4q2i5CTSruQU3ythn9xTU9Ne02Fc4SFeKHNQ9Y6jswuuHC/jXs3PEG3q0NhebG4OIg6fohrXHN6TOxlUXWgjYyBOYe7kXE+V4F0TlXbkaQvi4V0rkuaNqReeUZWlquop4+U54Hck2VuuVHOsFOoRaBkrjhIx4+tOn5exbPcqj1Svagux1GoZ3Ck06hCwm6mjEx4vU+9nsyxirPAgJNtv67VbKUquS9n51dVnqY8h2EoHkxmgI59YKaRZC+lhjumhjjTxoouIa+zmXFVNHSErKvVOWi1OG9v25AuSsRzh0dJoiqzrbJ/HTvHxFNCdHBltpJBqzG1UYmou2W5nUhBc3KDkLejpaqYuyS9VVawObGvUrGjuDSbyHytyLGSvzQvh0egZ34/WoAnSYG1ND+/amGtpYdYYzNum2FdUDyNypZ6jDV0ZqWInJlXd6h4jZOcr80radS4walnQZOImVDOqoBkk4+5rUCqYJEwfWsqoFN7k5JxPkWiI4QfqVO9opNCfUCEhrCbokeBO67SYTWEhMiUWb+Qi0xMu9o8xY5Eu385b1q5mopbMaiQPj81ipadVodRxmVwT7+jiXica8uac7VfILWWpqUsXSmHu4RIja2qqJg7ZjVXVboxhkSERHhLuqV3r6KMS8uGc3bhcnHHez+oh0o9xU10hStOlKe9bUa8hlq8Jr1KTMjHq0O5GK5gr3+VXtRnm5VdQ0CJOmZRRGrIn5m4Y7wstXOfnqslgC3W1y9hOcvEwK+mrmZZTsiCx5/KJrSNZG5bXll5zL5KOk5UvjXGtcxWgcKKXpRrcU6hqlajX2pBmGkyhGJ+e8GuzD6yQ6KGXIeVsUqOcnQwVF+1yo1ycU2AfWe+wsFoZCWGonBClqm9ghyeuGFljmyUQ5KKqla0clpcpKM+d8jYYLd4wLGWgFuLb5w0mp2vcFpxmUJNW1SBPHm8U3Etbr+El51Pg4qh5FSionCtn5K5l5c7fnaSjnl/eTtWf65LvHtej1gztmpDW2m1PEm81EjHv0lMU4ZrnUWUyqhOtCuctnyDmsMvgmU4dJtSgyMu0pOorMhy5WTQL3tSw6swk8VVu2qWvz23oJh4tjdBj7arXA2HlBSGkXq7OnmXl0B3TF7RQ7OrLkpCdTNVuyOewmZlhtRfkjV3UpZews2nwW2xVn+RD4SMS22qvShMqzJYaMd+p4Wid166J61wXLqeqWKycLNXhp47gkWAbDMw0HN8lUc7xkHKopmcKdbIsXanwtuCS2xThdFryUNhbDV8pHBrNoNbL8bFIpiYzbxzyDhIQpF3SkuGikA3j4OLWlZMiXlkiJ2Vb3aKQ4dfbK+Go8w4T3OZpC2910FXeyW3j6ueZkiYOtl3O1OYRyRvVcG+RsS5pz5ycEZbzFVEri6CH5zAJovRzzmPss2ddZufplabX4BinZpFO0WBa3FhgUJl0WIsZB5JrXJrc8Z0WJzQa3ipUWG1WEWuyl+vOFy6fLlZPk1TrEVdRYDGqzzSrEqniLE1szt+PoNhlpdRD6kzcNFZsTCZcyGJ0ju7YJc3yld+ZFawiakvQEubfoOzNzGAxj9OpIQ8tLuqfnF/WF/IM8SWS62yZ4DDRaJ/l4FarpMyL5d1WbqViZg3YmtzP4NPlrK3RGxGh19VXLLCLrKDakGIM0Viln+cmEyisrx+uKk7KIxhsl9rTrREQ6lblEbFRqKXTIyUaL81Y6RooL4VYWiQrytAspBUmYqau05UuEqVqEl9aInTRXex0XioXJlXVKc/MW56qpK7XzMqLF8xe8o2WFmcm2hyqjVbXn9P6Ttt1kosyUPAi4hKa4rEtKRgJTJHpa8zYXqlP85DqbKakhtxGbTFarRoHIZ5mIlyPIkyMMjSwTtedZRFxEMzVLaMnXx5UV2IvLhfvy5D0R/AdHkpOYBbgMyKZM0snDvFTH2RqVGwNDk6eX690TCtmJedUotE2KYqKbybk0Ccf7nWwlpIx7asXIupxaqbb187zYSWLsg7hlKARrJ0Q8N/ZdOrtB+Fb8FSomhPPsC7eYG3hrZgaMBHh9ZMNdlDz4addLl6cFKzqWFczHFRM7pXkjuvhZ07LXgqy0V/IEqhvY6zdpMmmx+5vaejtmrfUo6POnc7imOQqy7IoMaCZYAtP8FASKlgW5p3Pm7FznLKVmaBQD+QQ4zqbIDmlDy7ijzSPy50N7fHk0t6dlS+jLlCtMQylbyxX6PKwi09P4JLdF6zo7+GpV+SYrtSTFlVoCbJxL0lZC06yCxtbLyM3oqTnFdSH3JVJYy9gMAyYKfBv1shY6+8rNDYL8VdtDbGi7uoXniGbGVJFMyuQXkyap+dYn42Xz2gtF66uXzBeG43l8dvgTykl7/HR04zZ6WfrrJ1P5+8i5Qx2XZyStZVUa16U5OMNraruZmpJ7FuUoxdcnN1LJl4aV68TYxcNMFdrzaeh9dki2spOSmRO35ZVtjHxjvOXDDIhZ+HizA2huNPOLtthUVCwH0knYaHxHqZU57VUmmkV5hJw1hESGtJ3GGmLzopUq/EUsvBSLIsaZmvcso6gnrefn5zwIN/gdRvdV5LW0qcXEJzdUk/qKFvf83GyGV4mq2M0JNKHZhqm6TZ1CyhlWFbSTimk7OjNG5CrcJuzVxcSOJuc7uSTT2rWSY7lSlolU6DkmrMaJGzhWW7lUfO02RIy1PFnXq6vHxXM3fSQzk2OMbEr6pKq4lyfcDJcFNjpZFNh83hUT68yjS2vZ84LrIZsoqtR3tWrWycmcF9glCqlIUukNUumS6upjlZxoAzaJSFrDKiTS6qrLdTRL5M1dt1Zr/UfzXkUpymMqixQ4m7d4OoUI2oPDV5NI+xHb2iWDfEklKpUURzdCNwI3qDhGwsmLu7xYRtVaiYsohta52M1EctbmF+d2bCgNM6QlNmlCtQeHCtX+JfgCu6f5xLm9zUTGvJhjnLY28mTklTiazFoX5escRxUbkqTJpekse5UnAnTThYW4aOOrdKis0/ch6XwKBuQ4ueulZyepk9ibZ7gXvKg5UrqaWELjZAPo4wXy6ELYqMv0+uYFXTR348go2EoEF4fURI2FKyT1u7ZsZio3dOm3WL1m/DVIyJor/QzjOcTmgtXTB+GMVyw8I8dGK7gGmbYbujpeCyS5bQqaBupTG8tlWNP897ek6OhJiXvp2lnRq1o4dIeWujQk3Pc2poQdLKgWhYiVKKZJKJo4miYInCrjVVYTS40qOjbslnTlK0bqZWJnJacM6P04c/el+YjITlepNiZ3iLML9uEZ/GPYd1g2O+wCrSbDJIomQooW2Sgb6wiUmyiB2ba0rCY0pKoFepzDMxvLh8O7p1enlI59BDlUSGfIdfXGhPL1q5jnBZZsRwQixrqmPISqherHeWR8tPlWKeTWjPf7t0Wk61ToBLZkJCZpXYWlF8RkQqpFpKlyaeL5uEoa2vPRWdvZC6M7JkpjCwv2Yx1s1nM9ZYKcJ4jbiDvle0mzaEwZk6QNyNPz5vdzw6m1nHol62mkl6T1lRkUmrtn83t1iWpViqp5BapHd7bMS+vLOYNrt9QD24OS+Ep0RFZIWEPxdSWaQhisFObaFVytSXQ49yeU7GW6w9xZ1zeLeAWVpfrU2Wf61Kto81m67QTafGR79zfkaBwVuZZh2iaqSmHUKP0YHQa3C/lMbHoIy4voiTtqTVpyCWtpPDscFMLo25QIGpuGaPPXVlY2pRl70tumyjm7jPiMt+ZK6mZcbMKKCuomx9oDyHmoLQarZFfKrNTarCYGgpbFw9NqqRcKl0U8G0xUpmQKK4eF2waLh/T2WNJ3NGzpA+w62Op6tZlj6NTTFwoWWjkqAnddlhsshJSJ3gVGGjwiYmP6K1nFmfWD+db4yuYI6xM+SzTc2/a9fQMJCCOiC+b8ZYfNWByJmkiUuqS3u11yR7oVsqkaa+c02IpobLztQ4x0WDcmJH0YJQKZ8ruI2jfmdQm48dJjvdOmRnrodpk7Q701J5XM6dL7bTZEGcQ2+MZ1cwyNUy0GNhjbtFbUOLYHdwWZY8oll8ZozVy5B7nlN6XaVYt4i9NsZ2fFmsv0hWP1bFb1G2aj8sNmtnSleYnHONh7PWsYtbRJGmmbCyXm2Vub5gx47QMo2mwV2/xqdiZsdpSWxrRzxDwFacONvPpsg1hYcoFTG3OqY+MXyAmJRQfFE8asynXsKjekyH3bJnyWGAZ8EtRad7l70TsLK8XWhNQLVgfkBkbp2Jrzqyqz+Di7JOZH9qrGCRj1Szy4xJpmJ8aafDlEiPnURcv+BBYd8+XdxMgn1Wp3GZZmdCtU07rrpaW4F7S61CSqaax5OhQl2HgY2/P417Y5k4kGOPKYG1QIllaWijUktQOqS4y1AkbcCwPL5Zc0OBU0/Uh3GJS7amd7wvhIV7yrrMtyUklh5lw6NjqHvQXktgtqdImraGQMk3PZ3HYXo0YGSHvYiBQ16lN7ZNrRomN2tUM7xaX1zAzHqZKiq7scVfLNeRcpmPhLJfclqOf5PPcUqNTGFydk+c35RCPoleeW+cPX3JNjZzNb8mbaSZl3A1rp5HZswzVj+AQ0G0RFQpNrdSms6An2pTiphAV55FZK+MbkF0a2usM7B6p0hs27uNYipdudw9mHVnvXA5m5xrsoGpwGaGoCKjx0O+THuO0JkqnaWbfHGFNro/eFiCoqGTk2td61W7Q5OD1iVFqMw0XKaLoHhCTJSiNbXIRG1myqQ/eWNDV71FhsFYOGmLOlEmeFxtYqpXMj3DN1XSV2htUkLlUI9wST9XRbBxXGzSKL2cVIxzUZTCeydwkkKhYctcT6xdyWtPcHqKp66EJ0B/saFUeiyVV7YwZDmFuoMrXsPGQZrUU2tBnLtnPJ/LbU4zi0HakWpFu1PIzsCYfyeyMTNifZKEuUnbULlT0LaHjLCDaM97m3i5f9N2vpMru8mLsq0zbYKXRp2ic1qjWnxsrVe3WGVnNsZi1mSNWEhggYxaps5JZo9Ej3VpNTatdqlLpYhtUKtPNWdffrE8pGt9fkZ3N8tOZpiqbM4ck2h9octFmX+FK1Gzp349fpMwbnSTd9GWqF3Gz1teoDW7mDWRi1gsrIlmzrVcXT+oi3KWOZNYVnttK5pYT6pNRKdtMKyTZGuZi5ddTa9NlJiPmYxLwImuW466r3/ItJmHfL+OoL4tnLwvsKS1fD9GNTw2T27GfF7HXYmHxC+Y0EdgrnSsOWBJU8lQkrqhe7i1bTOKe36tLq5qkamA416RR52HibuBkcHGVzuuMaU2glGaSZmiT0w3jdXBQSNxLtO7OVVNKVU+Ka0oU5lkan1Mwk0uRyasMcV7q2GPQNBbins8x4xGmnKZVjmvRHnCVI4tNR6BV42tLpNTpl6mTnKhKqGCUYfUiF/Py4xQ2a6mw7dweodFs7BrRGe3g7g2UbxMsLfClqabt1jBqtCzts1OwKeZw41Tv0zwnqbfdmB4TTCtQsioWUfKZ7galLqcSYIqopDKWTHDSzNlgMJeXMJts1uCr0TAi0yOhC9Nx8SmRqazQVytxoU7N6mVl5qvxZmAiGtTkzItUJvMlEZO2noydzgUnb+9K6u+qsltWD1WzDVOJHqKP4mmtme0d1J/sdZ1vzA8YMSSqp/DYHCUjaRnRF+ha2qMgthUe4mUUc/KgVfSsIWzXzU9yK5ngq7iNrCNQbiklwuXO7pDoiS0xbgdKbGmUd1xYsuXRlF6pFSKd687YK6Px18sfDx+vTA4wi/BTMXNYlJnZZxFZTRJOJRmdJJxjWiwbryKUVfFu8QnKshjPMErnH+HrbBkRcuwkrSFZV2li2SiYcmI1XtpljxbyMF2M7vAXzGKI3upijWOWLM1xWONQDJPi1KpqUifkb9emarVwyfCmo+EO1qRVWxn0mvZjrR9t9ixNbTRl0wkbaWb36ZUZ2GzxkkxvUlixMyHZo1zpahojm1qLr6qu1Q7ncdg26xfVpSFkFDHqG6nRW+Vp2SHyJp5hW6XVT9O0orPpbvMxbyeWyU9j3OWjJuJ3oVNPLlkzqPENYOYQde8zGjDi1yJqljcbmecyIfiWnNtu7WnbM0rVMJnM5UxPo9DRZ7HIi+nR8dr4DWaokjNe5KwbY0ulMFiL2hRzJJrrEx6ZG7CrKS3akOghJJBgJVWxXq+pzVWhLiWkzuxvnUbOIk7VYdGNUSkqKcpf27NjbeB0oZ9U4NUTHWPR9eJtqehknq9wm2ba5hlMdU0Yy/IXkmhkXBKUkqmls+xP6CdXj68vWmsTzeOdapCiydlRLuDXdpnnHgwMcJOWT6VI0iDgj63fm9Bf1Qpa2+1IUNuoLhXc2+LeXCPfZVsaoctbT57iWVMrlW4crxdt2c+nylPxYpotrWaRli2mntngMt5O5arVWHdOcNVbvY/tqhDvX8vVDUhiy2IZnOu1lGGiV5RecOfpIOtuqNFz7u5jKa+th6gT4YquziZdMNbWa5aLipavVJ7hqaJQiKhhD2WnKBFu8GAV0SidYwuxC3HNrXGNZdJhptxucB+TFdvWYrLYlJLpaydYYhHR07mW21Vh6BKV5WxoCKGeau2uMSMs2QykYJLXLdLfyrCaD2FQLDWtrpgf2Q3TmjUhKpsPna0QGfWlURgPa6rhJhfj6d7SDu2MolQ2as9V8YqJtSploRjW4dvpU7JStOBW0W8YNZerq+ErjiquSRqS31baVepOzi4rkxfs3k4TZ+DoIU8XYKQiNVxlj6TdX2YZkCbXMGAdZN+WmGdm4wzsNe4QzDUKaJ8nTRCi76C0nGHnFXJcoM9Y2ykWHF7iHch1owruD1MUpJ8gDi4xmiCOa0um7STJ8+ZQLI95mpAJLJ0x0GGbslRgBfAubbGnVaYhaF3Vl5PT49ir25kXoezc3oyz3Y+UX9cT1RQS3jPxykoukWgzMG31lLWSMM5plN80JSJTVXLdms+yWh7sKiId2nRo3dWd2OCuaZtvW6/Zr2olTS3rEIVo3uOljfQQUV1Zl26wWmyQoU6r2bGdV6SPFjVgaloUYsxVqJzl0KNkXrAeTLJE15gaNLOTUsxWXJzub+kWKePzKo0Zb6utoGgT01JnIhOq6VR1VhDiJPKPrFisWtgN8WKXrOLVWe7u1ZOVmdVV1E0lkdNxU66flp9kGOjlIVtkKRgznI5KaqAaHC+pWu/K2FlrUfKh4AeMbzGV8RfKtKcVsCoslDJR5UkqJVzrb5TW9JRP1RqtmR/SIg3qaq+gT1Xenc0sbZeV6chNTI1Xx6jNKkvo3Fgg1KYiLmNV72OWdktZU2gWb1OilxtrzWX1s5xRqQrX5NdyCR8WsU+HIZ1yYOXyy8saqInYsNPglyiZZWownmWMzme1Lp9ZDxxfqNGOX3MrHRErnBmxp6Tj3uCjpbEa3XMXlpcTKqjeTF7WTmsR6tioizevG9goEo1MWXNR5gsZSZaKVI0f0VmL7Nen2GHeKxdTn84mj56LWE7t35uhsCxkIeCkS+R2WeoY2Y9NmGHWW1aorwoO49ReJpyyeFSa1aWknWIJI8nN79DpKJPjoC2fWo/nUjeNc2jgJdWMFPUdjOZeci3ZWWrkU69m62HmrlLoVGBapzWSDw/wDU4e555eoVNwdBzvFlaNkB0ukREg26zTr6ciElZp7Z6sDDSZFCrLjdTr3NzjHBfnUSxnHVLmMmeTaHEyXCBI7SMdy+yQ6N9LJuLdWHGY4Q3yDnGhLKKyb2wXinRmYekfpFry3yZQNG1iHCgQ2msV5BeMKjEnouajkZIoHZSUH26WXNN1s5uVqBFnsqKd11N0FOXnHxWhnKGWE+jaE+kfVaFornEmVGTQT42p0FQapgkgImeqbKG3zZJwLSvraazTl9/l4ayeoHIerFAWKDGQYKSW5BNalHONG+xQarHzsYnu6xuK2FyRbDUn31HakNhWLAgkj/DN8m1tXljWJ+Jl5xitc2FMqqSlccvXFBRnDhedIccHJ1Muot7t303YV1tLjSRxSVensG1YjVqbpeqRZ5MW0HUYawxxo65k0cmx6qykpJvo7taTso8oso9nsuxKYwrsHCMSEmUOLJjrTzNNHZagHawyiZJoJ2YL0yuoDqjxNBLUpa3WnRg0rtwlreVisfKxE9TobhmqKRAPsRai73IXiu4okxin5+ws4BexV630W5nTMgqjKFfRZJ/g4m2ktKZRHl3PaCLL4x2qryEK1B0cle6WUaik1yXlniSfcDGdDBCxst9y5FCy1qyjCrJPp3OrlPBy1J9ncFoKtaHyYOQTz9QU5/JS32stiiyzSnUKkVrr4RhT3q51lc3waYTkmVrScekkllYmVxTcYVuPMeaUki0aJZAs4eps1t9S0K3N8SHPZ1AWLRic38tLKY0t6may75BpMR/hcvBYnqQdLjIhrx2exAzVcY9pSbFmaONkpc/kEWen51NhqEgkUxbX4hPklUyzGs3tpaMZ6vROzSSNIuBuFtzw0eep6k9oKCXiomMb43ENEN+lT/PZXdTbtVKbpV6TdGYxVKweYIwP22ozMfMSETFyE9sScdmXHpjUnVyelclxnhiemwvoJtCmTwzT16yTmp6U2FeaEA4Z1o3mkF+b5Byubk/h5yStc95d6pUnCa/n4RMSV6FUIbSc1OXvr46K3mFfkhUk7GVlEOKVGK+vntIwZKjcI9IwpV6yVtumjS4RUFykZaavy7BQLuLzHxjTVZ/y4t+nMQ4tDNGYLyCa7ViNGnCSMDFKr+4hrq7JUOFMcWibFLTfYF8nWswGaRnmNS/UIizrFmTW12Zf8chL19WzKFhjC1RNnVvIsnSe11Sf8XIqt6mK2+LpZrFTW5cxUljZctJtaxqJqhqmDgoKTJleX6jiXSlnmGDwY0ys7OhMFGPu4pXi3wWdzLPh1BMd4qVoa9guHpYUpV1JnM2xD0vmEevMEaoc8CVcVZkLC9IOGW1esR20nYxaVRyz2VbxEFDSKuLamaJdjR8Zk9V2ENoRGlSgE6xOECbl3Wiq8xBt5omUq03oVdcmsyKon03UbbRPkjIs6yzRsS3sU9trUyWmKO+aJtMQGNv1l47M26RkzvSNlJNrIRDd2pscTO9wokibVYqgm8dYpRMvFWXS0KbVpzASoJIuUfCwjo0T2+jSlytYrXgyGKicnXceMzvjFp5rnQ/wJdmODO+PpdoNEigmHdV6IewdKdBjnDYm0ppu3fPoK+kmcBJPnZ6ZH5Ne6JUWo5FuzR2lypNY1bHRtJ6PFKtMYyZO6eRlqashKaxri9SonDmVEZExHWy16qRgWiwhKzJOLw1mtJVtCK2U8JZcmdOrKicO87AxzdtrolPbq1oSoO6XE2AZaTKYa5pe31kYJlEYH4proSUy7hehXLEgCy7iIOIVdNXXN9eQ+lMpajAlRuNpj7CMkVyeo1aSEmJgjovZVSUtjOXsT45m1aieqcZRcVoPNHAQq2ulSddbWSfvMSFvYs+K8O6pzdNezHeS8FPoo5tgYxEIlF0NljEyas9nn8sr6avt4SEiWrwt1ZwN2GEfbI8rlyV1TurWb2No8mGk6K1MMQyY4q+qpJrlI47oVzNIrSQQMHeb8FdcqmxnqdxrjnZdZi5vXQyhcIdfHq1ZSh0VppyprAttphemyzQSkCEv19PmCOLxybHjDWBjdxkldaaVI6ZmJWB12rVxa2uPmLLuY3P1zMyljhOhrW+PKhKQzxwqYq1gybEMC6WNzSpY0eVxJ6gL785n4nJhbvLwiK1UZ7JskqWXqKtay6ZRGypxnxAaT17zIeSTn+NZiuucYxNlX1bGbdX3oO0Lq9EkGhUtoPar2m/1jGFP4xIl2e5QpG3i0FPXIespUCyVmI8zo5giJ+ldryFLyrUaVGaTdmRdUdjtkwvs25chDuOtTOInY+UyKlIzihdWJVHk4+QuZHJltHLfGyZx26NTKVUgbmaSK1eQ56tYXeWrJibcTV638tXXJZNdkSplqt+P6KGe26/lEVrutEwwD+o3alxmYs/TrRyhj1vrZKhIp2pxiu5irJ1v5bDiqSIYs0pho9lp41GoKGQw2uGnnjIlb8takmDKr2q21xfhtBlOyplmMNeP1KHR8ljRqApwdSrPaeHr05hmyNKuDqrrKdTnk8cxLxIxMhsfiuuaq0wLWd2gFSTklIjVqFZtXh1i39TrUFKe6+6pCE0abKzrmc7QJOqWLlXnj2xbkZ/YqB2kUzGbSJ4nm1L0MSYf1KHL1SKwR4fJBqicIuUJ4OkaDZ9SUzavnG+vJplqj3wmlVSpi9wiGqLLtExU7qyoZ6chmyCRL7OSLXZVrhP0b6lSMSVf49SIVemSLukm1KJrzc7ulk7VjpnfeB0XGZ9Y3aVgX9EyDaIlpI3hGm4YKFdTKGEZK6vn2bhtoE6xyuoq79NuMt4V560d69OeMEzznF+QEpRZFWuj4hXWXZjlZG7RVk3tF60Hq3C1ypigDyKeriWMszanba0r4y3u8BXkmo/RKZQy4BZkEVHd3XSN6Y0mUBZadUxLV02In9kNmGBu2NdUllgVbGOPCeRnGsgabq1pN6tglRTXKRu0EZGpqk6eaW0OnVAH3bRNXWZojY9jNKJkqVeOkV8aG52NVekPMFOecyzsYVsz8ZKO32loctVa8k7YLaF3KHCOE6ZoqAvjMUhkhZpPLYcaFusPKrNmFFmsVjWipFVjjNzyFhfOktWtnmlwKxWVxvJqW03GZiBjmxbvHW3yrOfZXhUgzJ4Q2R5rVaVqrEoI6a/p0PDcFZBcndJbJCtk7lApodbkFTZl8s/lUpbhKuArqwbMIm9bdjZb8mFnXeNUkF5T7V4JDG8X8pHfsFOPVyYqnVpppeCd2RdgY7niVFRnnzLh6THk4RZdUpkfVc/TWwasVqQZHVxg4nXSDaYn7OPmZpBVL/M57hHkYWnJrpeRrmfzIJPw85rybl9S4KUXVY9XdtFw1RDeVRYgjSsZ3EuUVOcp5onYKewtXGFnm/cf0vDR9k1PHc+NFxHxW2CPZzBex6XmLaktIKAv1WBWENYlKiVqTahM0WLTm5cxXerOEV33addiaSZfKBjf8krgV41W168vFVOYaJJZKFCXGp9MWYoo0pJzDZBim8cxs6NrnHMUmVqVV0xjLyJS2BpiqZdT0hOvYzEIDKW0FSaY2lzw1uIW1SaT8xKiW+LdFZj0rWTcHWnbW9zfVdAzb3CLNLMUYa8NJdtf741bKQ0XLys05WWjMh9artRPL551GtNTdZw0TRkh2thPMQ1cJCZmqQ/pL82bMRGabNjpG+PZpq9aYvOd0RQW1eBnJ6pZ11rOkOObqsujCWxG1+ij3hgx1dTvodJgshihDS1a7d4NnVU0YKAuk7QU29HXcZAOS3WisSuaYOsWbR7p7a8h6uRNpWxeTyVmlCMRWpyS8Z0T8QzrqA0UC+bgRdznKsxxJCXrcBRaDhvrICPSsN7cm5irrhg1SZAPFWaylDGST/MI2qIpJZlyZNLSoVSMXHBw8O5m26Td6ytPrnhb8F8g07OM8TFd1vCvna/mzXGW4+eb0CpmX6LWLvDSryXkMCQsceBQJM0gmerW3KlV2J0mLSHXI0jZEFXUU6eiqQ0h7ONtDWvLrZZiShaPMRqk5U9YMpMbE96O7Q5gYFmpbNUeKynbJRySnqIcL4lNacktMWnR2Y9UF65dDYv0Lo0lzfQmypgqZKUhq+KnYdkOri7zKdQP7awW+SFbJaOo00qoJFQks0+gV2jSzdLSmtKs5lNtLe5T7ePXIF6T7G2VctdTMCSurqXski3jG2npXFJV1x014ldsIcwtsbCxZvUWtJcXpmVxsDFxpzMNYyQzJxOX0R4WTtoO6dIkHDdtLdCZ1+J4Wyyo80sXlA1vc/XMaisMVPdaGuHTn1leFF5wUWYtW6kk2pemHBZkCpBOWxItXVAozvWwqyOvDdX0sNNilOvta8+kWs7yZheY5WQzGa3tyx5xVaph4Y5rJLBamw9k0VjZsZik7mPfEMx1lSAdbugyzgsP0urQXa5xJsqpIy1HRTHtmWjS4Q/djw/bUPQZrReLXCcZjsok8B5bl4qoFk5I6C1M5iYSHO/d0qgK1+5aWRDsjDKiFjPtpxCWsVKyR9AUJ2rcCOjq0bFVFbUxkjUTSBhtb9ip5mMzMt8MJbIUG+zLbRCsWxTcUWTf6KOcSwyVSFmbndHm1uR2ts+NV9vyrJxYD25bDWiwURDlmHhVWmOj2RhOYtZopI7k1tYVsNORj7BgcaUqH9QNnTAI7yxQ11wOq3FPsqI6XBvrlhYaLown6DAMpZcpU8xsapSh9BsuZVCtTYvpTe2cUecNtW4SLA3y6otUy2Du5kVIYObxyd5sXlGQ16XlqqOgtHSrK2NVzrNjBieEre5wGsqTqK3SV3GXYLFh492YWyz0mp1o2qoQVycbH6yzESBqyM/hS2csY2ST55VXbROaaTmZdheTztoOJSkvCCjvr6Zum+/Ey06U8I7QJFjOpzKh2g8vymUOlclzapML8iEPNe+Z6KUQo2+j2uoxnZGdLlSZsVOp7LQPYB1Kk/Ru9dHgoOAa0e/ScyGgqC+z5crnl+ijW+cnUpVL5i5e52qkZRYYEuexnuYJnKcOUlpR0C+mqpexodgpIrQe89BQDCKbliTfoMwM1bIVhaamcp4U3hAcLybSJjGPNRtPl+sTsDHxXNTRFOjxkbOSJ3GP6HOUz9Za3rGXsjBfFPDP0XHh7+PWmjVRTSvvqWLtkgplXfFnV01uYaZdCFHkZ6WgMJToodKtziFljzJJHQ6eNDRuZ00rKR+qKiZQ7M8VStFhXBT3JE9gIqbKlJho8p0vHxGj6fKbyzLMNCxTsZSysA6pepYcYeJh6c/uXqinICTnoRYUEpoWnisriqAZUfYaazDgjClYD5wslG2xX+SOE/cgG1wOl+6rFOGcZ+4l1FwV1J6uZlwtpG0pjOmjp5OX0Z3u3tLhH1ckpFMb51vntCdxomwSTU+hGLL7MayaGfOoMqquWtmd9g7Rj/Y0HO/ycJeuT5UmSVsnU1Vu8qyP1OzvasxRoDQWDXCr9LEgWhFRTKexj2yjiW/l2M+r0ljkpKnzT1w0EBah2xuQ6p8yLjOVDfJc784cXKkQExDh9d4WZp4Q0GOmp5VPaN3a6U6IYUmUbKzfr20Mm6nqqFBhjc+OrtllzZ2o3tgvakluI02ZT6OYD1YdtptKb08QkxnecSGWWNOkWO4lWzCQldAj2mLTWC+z9DQmmyGpkqgV4+XTHqRY9yRcMyC1U3Fhlx9RK1phsuZvmB4Krs6Q1qGyL0/y3Aiq0y2V3VkO7xUPdN9VJhZRV+zLrBFyHZjtUvAv845npzPPH1jMGqNiWG9i96EY2oqlMNdHTO6SDVn2ediXXwv1sk+aryazFRno1dLKcxiVztUiIF+hj7VsZE9zSiUXbCXI6x6oyeUKra3wXc8l0ysdS66ROaHu8+XTVDJjGtXQFN6OmVKgESBo8jFL2iSn3BcfsEziKNUjbNBtHmKU11/s3Cbf6lw2j1Jy1Zu2Xdcf11tj4LOw1ZQOWt2UFdEzIC6qjmMPLU42Tdk2EU+ladFnZVnOne2YouRibFsbXTSpzVeT6B62FnhWiUmxJ9QZrPGK4C0dIegrIOuc5ZWT1nTbVKospaphra5V405Rlt7v3Gzl1yBQIg6bpFPjn1KsEg/p3lZwZjDSkeQQ8ygRcucoqOuqsuveGE5SkwnvZrJOVxdi0mrdI50WT2hhVYsV2ZNh5tp1FOJbbh8OFFzTFxb0Y1fLJ5U4HXRRJGGvh64jreXwZm2s7GqM3SqN9hZfThktUDE1a8/Z3x9e4ZNlF9EwIWdRKdcak9Vd41qx7JdRG6E0JDOrFB1QEWrn1dciTO2kl5erYPKoLlofZM4quFiVDx0w2hbVDOEO5mmcHSGRaPINzo8S2FKm0iI5Epv4ZMyck5sYnXFQVosPndnfpCim5nFUpvGY4BKdzLgSdNOupYwoFDBLS3PQ0mOqWF8zcFllK7GybAvUy1hR5SPX69Ellk7vp2roj09gMlrScg1lmVcxMOWMYrdPF/bSDmTQkIv0b1VZSKioWdFf6yksIpBvMB8qsQ/ldnJZDJtdNHMQIWQis51jYpQnKFAucMmWTSvZFLGdWJ1XFRiblKwo59pj4EnYsVSt5VOdmPY09p0PNBhnlI8mXe3ql4xNMdYRE1DW3kvRYg7LruW0GBiQmVZY71GXEqil6xUo6KzNaU/ULxyXMSFb9lDpNirTkJCaaS4Xilu0qp1MLwhWdSNSH63ijq6hDthc8q6arxrw2i/W6R6MFGFcyk4ca6/hVI4W1N4XL95Jm+PgsY6OVtsPX9BVUswO5mIR36uQFRxx7Y7RWhqW6DkSHOaLZ6irWNUh5cfc3qBUHBbWYpCzXXFyme5gH2v0X5IVnNYpVlra6anb0uiTMDDZI0fZnVefIpRr3A8g4RvnHeueGdGTyNfhy2CwRxHuns1M5KEkoHMLnxwgkltbKKTQsyBpqekmrtHMaefn7CbW4e+m8i8uGhcW4+va5tRas5pWp43QJgy30CQaZ5yOmDely29njStjCvFwdw8Zz59ZZFhMqtMULAyrYVUQ1JqlV+8sngvWq91cT9FUlnMK46FVZJXyDN6S57Jc0FCccAlHLZ0eZ90k4pU09M9TFKef2Zov1RLMsQukVjMV1xoZXqOxtCgVbBmpcw/NT1PlbBFh69UxYpnZjZn1n9uX41ufkChXMlRWZN6KzLCPo6kkqB8OGe5nVJglJGFf4K4haSvHZVPjjVGaDhN0jNHRE0zOquWr8qdZjthgLm8sMvYxGReWEm8oY1mMsRrXW6Tv7GuwnfEii1UqpRMNWJc1mph0KOuVnCcp72gdH2/Y39vbm/OXnpTwsJEJTSZ4LyIR6hZRZ4tiJ3HZ7GFPL+3lEPGlT47KcOGW15bYjhBt6d8gVq5rZYfboAmLl2CgJFR3GaITb1OZ5fCfmS8M5aXTEdGepIweZU6qIZ4aFCtkZSkLkY5tJ91uUOhSNCsZcZOr3Sgv8fKOMw3hMCkRoaXZjyAWGaCtmfXgVGPSoxMXZo8ilN3qyiouXqY0sAmMosfO4VcliGtw3fRUc6gx0+LiyCgoyNnyVrB1TlXntVpn3i+WkzYbERDO8N4Y7Cxg0VZlCRxmkevX5dTWoqupIiKLrA1jrY1VX9guDHEJ4apaHZzgi6lXjqHepCuWoA/JM+Ya1m+SpGBR6d7fcOuqNXPM6NRO7g+U0zQd5bBTTA4idZaStJ1u6LduKC2Hq+YG5qaTixwc8CRxjSOWdzDobpvmoA70mVteFJZy89r0T08VmiFvnIznreJdU7Q5FVNkGOMd2DFLaxZxLnDo6DMzIi6uh+aUTyNTH1qXkfWNi84r2l8loHAw2yuIH6wcZoum0eopk7ViEXClk6kdGub1Jqae7OpI4twJIbZMXypqJJplFnEUmlfay6eb948t5+mzIiXm4nJd4eHoFJ9iIJ0Mk68clGwSlp3R+Gbl1afoLBOeqmClzeCV5t5kkJxxD1CzXN3eWZJqV92WDd+gidifmdJqDzHz9hkhUhxjka2VIijdki73bxNg1uzTYSWtyWcL1WJIZ3FkaqEW6u4hHVlqZHSKX2bvFpRwqx7a1+Ym0CLSUCZRJtR2HNUQ3hoGVC/k3OQlumBdchqu4uRk1lZtVClyrlHbVkutNlEoFHB0cuvoNJJzDdQrLMqL2GI0aabzW6OdNmGh0+kXGx6g5hKQWx31blNgruiuquUpIDLQCBoQnaSsBuzMcU/O9a9ONluUajAwUcysK4ZqIvEMo1DQ7Ffd6xljquZ2MmVk4OMB3C8lzDA0penH0S7r4VCwou1r6mkphVpwlnTp316NbrQkrhWrZ9KoZK4W7SQg82ONWtlgnVjmEdlTeDHQthnuIVVlFZSr01OYnFX2owswGuGrEKlcXGelHVER4LRhLmxn6a6YHvKskCAckGHdTvTW1pERZZchj/BpJuIbFe8zMV8fIBzflPQtXhNVs3PmkQ+PETae5tRt7eng791n2Y/QltHR8WPlIaacYulYJtoxcxv1a2+R8gnjIR7mJU4KJq1kpS0N2VftHrA0Jh5u3uQirMwlY6KoM9zmsNftMmOb4ClM19YnsMfTb+bWmJKx9+ER75KulQ3W3eZW2dOpC9Bi4mCPLWVuz9/TnhcZ4hTqDCIR5+it8tISr1NyKx0PtijgH/AxkNWgZ1vTFtQz4Evn7d6M6R/qIVwj9Y4W4dmQ8WhWGl0L0ZmbL+/sreiibQ4mY2pO0zCbZ5ffi23NN5Qe2/cNsmkSjCgcmhbXqy9u4WBa2/KT5Vny9mPXGiKj01mV8rL0memaTlpXcKGL863z5920kpiftCvW6CpSrSAdVVUhnBBO2VqyKuZYSjImDNVN8urKLOGQj1dO5dTVDU7Qb5dhJBjbES9abpskFYxj1y9ql/Hx65qfsdvV0kuNJhfncd5XKw1iS2dj4JGhGfFdORXZWywQz9fmMPUUoxMdHO6ZI6ayk5UVzSWN263p2Z/nEA+qLITtbRulntVf34xp3CdeiPGKBy1KIxubouHSsN/wEbNnkXROHy10qQ+aKFWKrtOSZHLz7B33aBAK4Q3LdZt0k2nKEmJridI01JvvC9ejSacm3Ron161sr4fLJ9OjNmptnHnYtxBULi2uLZQQpzCLVePs2xWsDfAvzN/aELLOHzRQaN1uy+cu2s4tUbQddNPS2AecquUiY5dPa42e1bg0USfzH8qrjk/WM++cbhpjT7EvZJGR8UtYpOkpkKEnkh8WzhSklmJN7FhmXlnj0J4lFZqqjGfJ4C/5U4+g42xoMQfzqY8iHxdL6O+w36jU8SLjbJaoGCf3omQbbOtaBRveCqjqSxxsn2FMn+EYc1ZgkY+hbC9zcRrX6athYKLrIifg1awLKmIn4pIl8d4LbqOwiiQfbljnzFaT6BXM30rrrqxrbZPHJ6Pe9VCPatzxnvFNi/JfXWiSEaDxbaEwTjhk62iocg0gmdNzpO3HkKUy4Jbm0BB3ns9Zp2iIk/Np493WzZfjNs3S3WTmSm1LHx/wmniTz9lfYJ4lYW2MbGJfIVAjV2Eu6J4yuA6QpTU2LhQ0tmESbRdnlKUQZ5QflNAamVUIqXEuFS5hUi8kYSScTW2G7i4X6yUroUytM84h16wQtNCojF4R7hfkbUznYWki8d5X3m9iWqnfKdLJ4mYXXZVtZvGcGwqNjTFflt3311zYLSPN5RytlU2nmFLy9A3raRhxW+CTziSPo5CR49bvaecODqLlDmohH3Avkp8R2yEt6Sxm3yks1S5WSawbCe6pH+Wb8dfZDyYtq8oNZBf0HVhPlKAVbLEUJYlQKdvetUfn7OYO4UZalq/ulxHrIt5T3ZCy4kdFoV9UiCIU4iDXDGUTFAqYE7ZVqVSy41sc2xNYFmvWYR2T4aXOGmiw3UdPFJVcIcjvUqfLi5pUZG3ulGlQJ5RM3fHRRxRU61wbcKSn5tOq8TBWTJRZXbVuWoZd7XGTYY6xKlPli2Giz86O1UiNbWPP5S0QKAnzaStlY1Pn4cyR48zaXBDQpphNLVeiLfMJVE8V8KBR8OZzmyQykhdu5EyRobaZLRQmkJ8W7S6n3hqWj5tTViBplfCVFAuf3p4kqMxqIS7U9AvrVGWc4U1wZij1U6EMMood17BslWTpWOBNDNHtY9XQcm2OlTCQ5pJSrCPkWc7py6NOo52JHFbxV7djFSFJNE6PEQ6o4A4kztUyay6V6inNisnUJ+xKTzBZo6EaKHS50hKdTuZrkZvoDjUhnk8boBOokW2mm6WZKQ6PqmwhHXHkDdyqDyoexq2ab1YVjWToLpTV9E4ym7cudVnS4Q0OHqSKqibkDuSYWe7wjCl1ciFeL83nJBplFhViz56h4SdlqyPfz9ZbTdQPj7IglCsO6x2dExRqmR7MaZcqjSuYVKO5FNKeoyzJbOwnME9dmO1guIxSVZ0zHmndnpLvmuUpLM2O6ytbHmc0tFiUFiFpb6dk218ZbYlhllpcnpGYbp8NUCUQUGzIKTCl4ptesRMQrE7XWWZtm5ovXNmUcm6t7EtS3vLsqsel59HfqJzldTMq74mWCJew6dow0eBy9OVz009UmywmY+rTaGhTMijPopkcFewp7ewsTiYV4K9xEK9oEFsbqg+jI8uhpC/nWMgqpiZOFZjZBx3ny9KvIFJ0be+gbOog5JYoKiXSZd+VpO/MWTHL7JMSiqykEWIdaOiYHbNhNPUQbs0JjKlqGd2pjdkUok4dlaIK7oru3J5Xaxyg3cyvrjBLLqdtGWBPcq6ak9UjULPdrSFf4iFmjuGNnZRqsdekWiia7dFwzx2meB8QX9mKB9FlmSHrmirT7k1OYeuyDw3aJdYK28z0olRnr3RjCk4XbWyVKiGOpiSdUXNVjnBvpymusR6VH2hqZqmC6GTgrRyRjrXyLtFs8VkOGY62tW1o55yak9hb6Fev0hSR+PMT1iGm5bTLXi9t0gxwlRKa69Hx6MywLWXl1UmlcRfrlpijaNmUaEyb2FuuS1AyJs3aD+oahy6kT6nnEo9ONw7ZpZQmIOXIbFoaoypSLI2qoy1vZVuuligy7PMtMFAN1kzONV4rXIwc2WROnW0YMBrhonRMpGeOLOBR62bXZVlUn6Do8w0ML9KUWWLO2+pSWBGm4JCKzNZP3m5eE/Ie7jKZqK/vqackaPMPtUqVcgqhTh8k0ivzWVfS71YtIXKp8hbmdXbUmJB41VkvDGXkXufeI6WwLC9u4evtDWbTSGBs0E4PolKdsmUXUBUf59edz5u1mmXTnXUU4a/gKZMtWxmsIlQfUNalUrBQISEwnrDi2RfpM3dNny4Ljd+q7uo0GuqJVWnp0fElYKZStjQdTA9q2/FtDVpxoUwj3YvVF+tmaI2e6OkusYnZGeeasR3nW5AppUjfY85j3XIMUZ7oo2QYq89P7yaiozOt3QzVDI21qGvhE0dJbLBXKbPtn07YcnDebW5QDBppHGkc1CCh5Y1JrtdLXSEpFB4MEJVZuY3p76cj6QxlHFNp3w1nU+fl0aLiMWeeCC0tqHWr41ju6ptWShrg6TCTEmlXpRRqs8rto9ivk5E2XF8fjIlWoF9qnOYwZzdOcJPeWlHYMp5SoFgLGzGrkN/mWVaXUaXS7g5opNBaVt41cTMsYtr0zDEv6KXSV6aQ25mqdLEVsJouSM2xZmUNcV+ZHimVG6pT8eJo8Q7P73TyEFQQIWmQ3Vk5nydQ7A3JtGkwXxeO5pYaKxeOKyeXdVBVKqAqV47vo/ff1tbeMxSdcp8151iTrW3NdaCbG8bv7kgjDhTOXNXtYc9gIrhi0x7lHrCbpyoTaI/1sK3UaOKlk61Wj/RlmGLV2VqSx5JaR/BUm1HY0O2enuw0TqGOoORM8akYSmAvGJESaBYXk13VYl/iL9gSjxixGTAozk7NrmxUp5utV8uxayOpJeWnYyBO21LOYw3apgygY+2ko82Vsp00i9nezY2y6Y3OHS1UWqiMU6Rc8lMQy5ogLhwO0NTLF9wcMdEuEiWdjTJKpK2v4RM1nlQaaF3Mm+3d3m2ObLUfqitITCS0qBGqVd2Ul3IkJB+rbLFYklg0GLCnataepVPsIqqkcNQntBxS9ou0+J/0jQ1L8wnc1KR0HrEhHI/Mk50unWlpUh1vEaTUqWOW7Z2nTzLd3eeqHzBrShiWpdHy3J5o05gZZbLd4qFjS5OyS91RF2Ms+SFalnMmqO4d6g0WjqnS7aNaCq+opCffS1m4r1sjVOx07OAj4G8Yz0rf2deekSJqpCObYCM0lNDyIpTlimkwCy4wjpHwWAumb99SmCBmKl7hEmHcWbKPse+OGJEZz8xcLBUSMFdwFMyO31UPIMpKEN1nMC0TR9oHy3Tbo1EeLhMsKx7zFbAL0+nYahArrwyZ7huaVN1iHhGnXR4WGe+d7BD15dCPdd0QmmX0psnuk5J1mBEbtLaL69hkElsPMubZM89kNE3ZaKVvG3CVrNhjm68fzagbbKSWZCLNkUkWbtoVTJJr2C2nnSkkUo9OFmFi0zVQpebbb63qj5My4R7kr2auXaPqG6swaJ1MTeLa1XNw4NdVE90iUFUsnNQTK2hdpZqOGvCKShdi4Ogj6eHHy7TRLp4U52LyclK3WTHh5mR13+l00VKtXd4Y1mhX6tZcKmKcjSsc7h6qIrZ42FA3tEpXzDLvFvPZ5ioqT6vUd1ybLyygGyEwSw7grJexzhMRSxyKaYdxZdXv0mmY4iTw4h5sjdxVHnCIaFqkcTFoqJPJmBQd23JIbxjtc3FwlCuqmYwLkeOTVtNQm5UsM6Mmai5IWCpVK13Kba9a2evY1yIoDvAfMJBwKhfP7vNaE9pT8yWVKNcq9xHwq1TeWm1cG7Ta1KeskpCg6i2n3rQtNXEOrxElLC5aIFfZTuqkZtCUJFILolfysqrkyc9dpQ6S3E5l4FeqBpIscGG3sPZI4CdqWh1k4x+o0adTSSdPC2oxiaHhnt8iGOMU3hqGmW3gbt/oWnNZ8p2XkfDKGM3b7pPhTtja5GxuGY/7D/cYNIwzEOeRFiWMdFXvoiDnavUV0e5TU6hy0mner41dVdShLlQy5Nkv3N2x7mMuM/Qrm6uQp8/e209eVF3X7ePv0xEj252z4zPMVdz2LVRPMFgTD/FQ9BmRYkuX1+RyyCAwr5Dm94yzp9fYnJdrNh6UDLZTYe4Sa9StStVhsSum5pIh6BSVGQtcmC7tniiiEx9rY5kt5c5r2ijLtFbj8cqUMyrL2zCuivDQMHHo6K5O2/Oc1zSz31SNabNrUqErpKza1tSNl6Ycbx+VlxHc5lvRTGtfMOVqbKDQmo2h8GBJn6FyK+9osw2cULfyGNIWS89j9RNfoLNw3y/VcmabI1TQ5A/XbmIWH50IqMuenJhzU5+pIhjP7i6c6JYOcoqcs+tXlBFmZWMxn/Kb4SWbGKSY5nIJ4vFdIAhxViXGXUcsGtvHXOEkYmgP6+flUKjR22nUUxXnsimfC2EcUuGa4ekqCZTMH96QGF7UKx6Oke+sFPfhqJiaJiDnV13Vzmkn6bGn4NO3WiLWsN+L18zNDaHytxBbnKMRGyKSpZKkZEsUNWHaclNwLeq0k5gmlSeQpxeZ62Qi2Oauk5sN8OuSJlwey1DUMOyMHNRTW5NaceTa8O+hnZtGyqQpVNXi5CWxbLAsEqIjJzVTkRYobu2XyqIgLnRg6XcOjiMwXaAjkmQiKLIOc+Nz8m+VDSYNqvUn1K3Kq6oUrKORWBFg7A0aLgdeL/RxVSGcE2td1JpG3lnR1h4t5WHb5S4hNY6dJczZJgrir0yqHzgQpyYKTKL1rtBxxx4wXy0fYJVmlJcXLOnOGF0W349yS+fYkBiS5SZXVXdnNrclE+5x7KKZkyknprAyLY8Q3XO0C9xcTEs0YVGlY21RExNt5xnwqYwz0YmhW+eP8tJN1RxVldUzpt3enm+m5cvW0qFpqeKpE0mn1d+MJOdYbjUyXiHfXoms9VPSZmtXUN6yiRSu0w7rrdgxmVXWldazi9OhkLbv1RgWmB7oX82wIdRXYkhwYRczDksh8eYlHaCU09Fznl+0ZA0hoCB2zx7ZHnFlmqXyENZwSC2OnughX1UjmurtktlsTC8q7CvQGpOVzXXnVdxlXG5fhjJVolNuUGheb3A1biWX3VuZlq7aVqomYehXa2ybWA1tFJssadaoWLOYtJUK0e1YjljM1Zjwz9/H2ISv4h3o2pNQHK6eDabM2NrkIHe3K3WN7xAjVM/Q0BQziZXcmqzrYTHN1Qybmc25ld0rJ6/UD1Y1qnYbmRUw4QolmfEqjigMZyFn8o1g4LDaR88urJKVTNojMm/g5O5rsC7KGRyyx+Jr3rASGqgu7FNWI+gm3VQS3LJUMmLuj2bsGdp2k6Einyu2T3URjJlSnc/sp+noHMzoDxLXdBQe3xuxqFgZ6Z4jMRQkVQuOSw/no9duZ21NoxQMtVja8VYv1ChR3y+04HDjB9AjZozlEOHeJdISoU1l9alNqpYshy/hJEoccSsjZahlnFCWT3EznZxWcjIrVaqhG+tdoq8lYJRYEy5NVyqd2uxYlI70rEtn7uZPCxkmswglcGtW4pMeCybdVNeb5+yiriWz1ijUUaUj6kysGaFfczCLS9Pk3B0kbaIgFk5wqlFrbjKPEFBRJ+li5ehgZVV0pLKQXfDNZRVV1W4k6vRYYy9s1G/ac6iT6Vfquk9i2K0j3as13FkOsWfGZg70c0211ZAiseDRVq8j5m0qL6yQNBJKoqhn7a/iVSAqSCincCSPl29lW4dpWhKIIgiohQhIxhhTH91orKAilJQsb1klZa2TW+Wa4WWHySnyKIsRKpfu9dfZXu5bcIvhCiXoKp6sFJdsKm4TYRGa8Irn7FjlUaOuThKk8K0spuoXya1bzxwVmyonU6eY0NAacyANeFtRzVvXHW7VaNbLa6rSUuZk8mhNJ5aWrOiSYA8ZswvI5bPZnh2PFZgzkGlrYipK66jQjuUmcd2ea7HgmagxaSWtYVCg35guMSlLUSExL2Uh49RmG/DqU0xlkVFhmwdkzpZu15BZS+TiTmvs4mWf4ymN6EsJTBmrn3EgbNXgWe0mU2Pn4PGkUpPoVNyYOA+hpB2jmvSj4/AiXqPuGhsrCyxPGNaKZhLeEhoMKV5OMV34Y4XrTKIcsR2hFyokJySOGFbuTBRfYNkKox7xXVzpa97M6RcYLNkh2B0kZBBkI9fPEtSRF57mzGAgFI9gJNfSLivXS4weLvPubFiXp9wp4zTpolHUCvEentvwooj1bSKLkCc1r6ygoy6KcXAo8aHgSJfmjNNmdGXwIl6NkRZXqLNUhwlsqh8M0hDzY6PjFFNbtdToSi5akWS1zGhR25DwpFPV1WSWjp7mc6SlGs+lLWFmofLJiu8hrsplhpAoC6/uaNjaW1uj4tfTY1dl1tLy0xuf4hiU8CWpip3p1VAjYhHKWyItFiVyknCQoDDoq7GhWRZwpMuKWbPzmi2yZSHO4m/u0lbq02PLHplqG9xRqB9NTCwOnI/wC3Pz0pCdKNk0Cm5zbV1sUaso16xlb05mMfCVa+NfE9SzZJsl6Gdlae1zUlgtl94hq6Nu5xQ3TaBd8WgsWeRuqybn7mFUam3kJE7aMozjKtJ30qFdjPbdr6XOLRsdmV7tqyMezaRdFlAsJpApqR8L503R1BEanCDcpV8wEwta5ZHx4E1iFhxrDtwK3Mzd4NqQZ/GQZFjr8mYJsZpXdSxYK5jTmJYQcPTVTyNdDd6tbJZUL9rj7i1aV2NWnA52juNf1JrO6GDYZ+gZVzJvZFBj6I4Lpyxlqa1jaJ+kDxzbrAboaebo3BxqzfCUImqKoBMx8FOXY2+uUEyk9qvx4hfiJavvKRttm+vwU6dUZu1urHKQZUmtZhqtF+Gk7RVVm4lcUmraMuncYouOZSeUG65U1/JxjpR4JLgWXu2hHtapVl4eHKJMnVBNnGIn5ukOzRUy56Wil5kWT1qon6Crrs4NFrFzGK+c9TNmTYyh56RlkIzmJmgrzVIjUVKiUg/isqAWEWPfD59uU55PiDJQ7d4dRGbay9PNYaGNnWBQaImj4OQR4KqYEE8lZ1strqvbrGBa0tzT0y3pDFSkbxbP5ExcLtgMcKIWCyuSMxC0XmpWEFpckBOcnelrJC1aIp/x2qstatCUEVLSJFIfGOgnIymOJKcl2t/yIS/dKDFfK2jwWiNMIg7hq51uT2geJeJJkkhhowtocyUyn5sQbqPdqddxkGCs6s2VsVHVjmUwpp/KbVIxjd8VVOpPXPYm2zNlW5pjcyTKmk3qr81JaWfqsa+qU9hXmNObViETSjCLcHRNnyNO5kti4N/rSej14F7i9uTL5RInJqpfmu5oi1W049JN4STn1eTVIG0jdwpTUKWQbJCWIUwNYKrZ5iyWG5P4Eq9iaZJLMhMWDHZPDHRkaqalcia0TqeSWLMVo13eHmgaXCXw2tim5pBR6ymVl2XRJ5BlMKavDiBeINhe8XMzzdZqsaPJ1vJXkh1O1ZhyKJHvq4ywMUzOJmoT2pWjs5TTadPrSx9NEAkXRrEO4R8g0WSSsrFjxenVUhtvp+bw6SmaEpowVY8TKBjuVK9xVqWXaIuzDdDS9SkT2k/VEgvY443dlJ5y3VoapumyIRMKCdXei+me2uKUTlnuDJ1ZF6zJ7GPPaBof65V10oxt1nCvpKIx3vXylU1voHUalDfg6Vhbyq2tpbONTxSptV7jXfFgbRiIpBcP85vcGhKm57D0TcyjUOanZ6Pel6UOSeoioA246qmPteGc2/GlSaY1U+CVpizo0VKzcN+YLy0VC4xvsEnyLxIaLtTkU68okWHjq6Lu6cltNCMbpzZVrCJsjGTijeIXJm5sB9xM0KSTH2phZadK6BSNY43xs0pSWqYsLk8K7cvl6dGt4c5VFJbh353ZqtXP5ljOYVqW0dUyXLKPYO3lleLxE451i9jWXLKH1RlUUlxeoxeyz2QQKZBqy2kWpJayT2WVtRSzMKgibuyZ5pjorzbMC0sYXGhe4aVQZNJZ9WURarCOZ2QzTSBv3pbolNjf3kyYKRDm5TfjFJlw6q9e9VNaLWUsmZelreUpFOAQ6Aqb8Bjt1hNpEjKx4Q7tbwfRjM3T4lIoUZPNDHaYEHhUG9/f86cRZM6qZZypG5WX7g0plCQXJgyVZ1EhbDSv52JdnhobLSSaZxyisySmFqtMkA2RWvW4IpKTrPaZTVFgGFGrFhvy6qrtIsnQEGncoxvaH84X2mPg4+XnycydqDCOLmDv9ma0TShs17GPthojVRpgj6vJyu+lIWLL8SH0sy8yT55bJTFi8+Tl300TrqpOkKsTX/gVbOqPy6OuZKxd39bhHiBMB6ZdKWkiF1PM8ytJUOXI4xCykJP1IKQiXlrplncO2y8a9bDqnY3x04YjG6pio/JSqCHedh3i4JJN9o6jY2utVfOa7ioPURdUyd8aI+OoZNMrDmFSEA8Mr6lypxDWJ5Is2bhtb+cRJ5T24Stt8Efxjm2yWJBnXKBcJavY045NI82V8lHWT4uGIWyrjKVSGmgGb1bp3HFt5CnibN0do9ZvKaeOrbMkl9Rq9syTMSOUWmnTU5vMdjeWJWreMpjNLEiWbvHKrHKW1ZeeUduvnWo0WyQN7t4OiXGQrUnTGW4hTqlsG6mQbIgqrWDcDgzzGKNd6Gfch6RSkIpiFZ1V3TftraBXX+VfmpwalE32VA43oZzV0C6PDdBpW6qRHl9gbJ3r7l1aoZfW9M4W1yk1cRCo0h0xKtfiMnbczCtsF9Dec2SzY6nUEeGfTi6r09wfHbdNcFLyV2bfK21h4pLZsaPUs2GlHiBTC6tLzufZ8pivWdQYV+MVX9/Ur1noiq/v3GwlTuGYVimOnJ5eJTFukfE33aOOUWWvYVeuI2aP4yPrkZxm7yVYsGYzLNXvIRZILbGjrp4Ukq6jzC8vo9frjd/YKawdCyBT05gxOB1eHOD1WaiiMo4SDOdUdVLrCpjilW6WZjKmJcwqmqrjLaZircsR8bfXzeE05u1sCykTjc5JpScaVa/yEHIM1N6V7S6O8mCf6bFM35lX1Zq5D5PYsLHRI2MT15H3kZksY2ln0almFlgZ313jXErmY+wQEWmrrW0e5dkWEiSo4HEIT/O2jpUoqtkmrTOY3GFzpm/qm0yPYI1c7p1iHRncDNZrI/FcDiqoaNEZLCGryNibs4lt9fIXjXIbIW8sivFzW18u8Z3lprCu26XQE1boGaVPDA0nt9Ck7EtanNQe3tYQZHMnKpZuXwqcrOCNFuv0z1yO8J3s5IvrqCTmo6lLqnEqz1hdDNjvHWzY7xal7iIq0DGcU3gsWDRtZc/X5C7RotYhr65o7CujZ7CknpahreJjk3QZ1LRx2HQw7s+SdSHR3OR0KJJ3ZBd4MZhmKK9brGzidGwrIQ5UkiGf0m6YpuJu2BfPZilt8EWpHXEejzfOn2injmh3UNyYZdIgN5GxSROgZ2YTHSFs7TMYcjEKzBorzJwmXd2ak2r3FFoPNHSNLV7rUc0bZWutGVnQ7gzJVOgSSBeqJ+cyEItba1tyFN0lT6cVDt8tD1ZiFbKfC/Eina2f4vY1TM8Lr47ODVqipgvn4TBbcQpSElZzjCwVWKSjjnDKauDachBO908aH46lV+DZ5rZW7xVVLdqV57DnplQnYmItCgjd2RYJ1Vtv4pifcKVQ6peTNqtTjNeo6G0dcNow8KRb66erqUixtCvQpIpxqxlqlY+WDqgOdObirSOzDRRjk/awZ6VdT9QylTbXIiiq7Z2qm/HYiisQq1mfsLWZ0VnY2XIX4GyiTxVxWlCZb2IbWGuXpdiona/rWpNVqKFtyyBwncgNljKf5E9WKtVmDiANcBfWiKHhniAtGKCUjaQ1HVBdn+aLmSfbLs3ZUOiwsSvMpPCXTQ2pZFCN2ONjdQtWT/XuWFpepRMdK9qhzWorXtCMdCGosyhOz2aOG/VecVqjq0fsV51LWeGpJxFvnJbxpuViWNymHhOU59rzJF4lts5WkidhzKulaYhUCi8vEKqKCEikSpAiKDFWa43WqrJTE14YcuPO5dbNNZBRLpRk1fVODw7TlF5c3Q6iUGwlSsz0lx1po+5U5N9g9NKO0ifwjmya1VOdHJdXlmjrkA3ZXXMZkhcgUd+iMlmWJ+WOkCFNGKAZi/LfbWQZtzHhC2su2WWni1RMoW2irPDlz0iVMXHlVFoPYFLz6qCJJZvY49fzau4RbdOn8GoYrtFmaaOT1pHYMAswpoqNEq2klqqpE6jcG24ypGdcj+TrnYdlz8+vqSjj3123IFiX8c7UMc8g6FOT0OVRWWtY9NKhmNdUV0mP3/FdbCtwkIlvIiPyLGSRY6TMcUpecLFKqUsnFDGSrg9uKeMKDl5sbBAMJh/i4q3hDUpGqNWgXODNYNKmL6bfrGwl6ZDO8mGoJ16XUhpnz+fWpZnk12LPKMycaCEgpPMolXPpcdampw9dTlCoMbVPErTdGHVeki5qI2OZUtZlWBsOoF3f71fj3ZDInSDscclRFFhpcrDt2UzZEZ+wmtcwHNMkUPCuiEkhZ+2hzc/O5hF2ceYcJx9ztEtNIBjthxRq1Ijj3itmF0tbMSBRcLEf0h7uKd5T1iusU91gk50faWqbiVwj2GAikk4WqXLdD5Ox866oi9RYl1jIkdwQZE4crq2qH4vgrKBzqd4ZKFGobFrZtAvrbylhCczubaHbyBxpE6hzS5NqLdNap454t8vREnKQa0fa81eRd6FuUuYSi6GwnBcVEG8jL59Js5nR8nQnSaOdDZSUGeYctdvJjKPnT+CImyuL1tGQ8w6tJa9wj+HhqlxRFO922xois6yxuFvm5BpJSYoi2xcamK0PzpFXj60vcKZbb2JP4KYYKd7tz+A262watiygjHIjqGpLSzIX153vkctubJHfMVIWshQm35XsmvNs54oh5HNhqCjKIh1XTmPrneekIZ2LG1Xu5t3bcmSojlEt5JPoLhBT3B0NMeT7bKuXG2iy84/UV1YuYu6kSWkj2dRJim2P70ii7oVssZRubxA28SmLohGYqdTlcZ6SSGIgzVdscVUjjuhgYSoEVVzr2mGdTTCfETUXVInx2PQXIauW0xRXnZv1WBVTb5CpopOmsGuTtKKKCtXzoJbNR/Nn4C2s6ernWa/oycvOodrkWTXt4+xwELPMZ5gesBRM2lQVbO6XDeku75wnoe5ucJ+ZEeMzi1jf5ZLfMFThctrwiy+xj84zLKGO41tRcSZbl+LomKzsMxCNkFJZzt0o8o+qL1wpNgnhUCLknJccDQ/u56AVYKNVdWYaaXAkj/Kxj+tSHB8q9eZcjxhfE4srHmWRMWYz3ukf6rZN8lIJ6x+lEdITLJmM8kjNW9ekVdYV1FzS6073No8nJEYi8SruFyNJry2lE9LWn58RT1Bfm6ZNXWnnpNzP4M7W7xYYGBGlOJ67kOfcVeGY2lFg1Y2gny4r7eQtk80qj+sn9c6bdC4WiY4j8NIY6lcXLh1OsLNrKJKu6qmmkdOOneugOO2VWmbgqnCmEhBnXWuzH+pRzGqdphBemB5QGt402C4uHJlvzdQtlmwgMRuMmCSk3tHOH02XMWIxhl1QoqewrrPXo5rfnl9LF7XPIZjN7NRR1DJhUGuJjuoeqtnrVK/vpSrIn9noD9OorRqo4XMKYHGTFqzeMGfTn47Qntx0tFxync3hpjDjL6NScZQdXBvZ4W7ZpR2WUpfV8m/cj1Jld43iLrFu7eSb6J2dVO5jSR8vYqLw8WRtcNGq1FZU1rSdzXKWctFLsjHeTRCSjuTu61PJG9/gl+N21V4Ooc9rFC6Oi8yfGtqvTpi0EUypkXAJc1/kk5PxnRYUq1Zh1modtmbncKPdU60odFNJmFIoXk8lxOqRKyRkoFzkLR4qmuPxj5xfjC6Zym5LdHMU5s6usyDTlJbYrtitz+BmEBLiqSvhpeORW9Ev3zANceNp1bApo/YSEavWJKEtHCCr9QoRx67joxOZ8SjviXHWn5Hh45xYcloI5ZFXqTQrnauotlBODJlRKc5jdukWammOSLHVU5hVVKZoYiyunhNrCezsTaKmiVVuj12up60XYA/n3ulpZGvLi3Bn6GJa4k/ZYfUO7mqxM67PKCvkC2GT8OAb85zKFfAU7C1Xso2LNBj1L5PjmhYz4J4w6pPTsxNd7GQHSbBLEo2Q+BEWnE5pD9uY1+XerfISJKmb2mZlLpze7WUdrApxFtFT55VJ9CwuUo6TYaCW2eZbCzEZrnFMnOQM46EvcFGfECasoaQri53a5EzgJTIbEaAz6pOzyw8Q5+xSltvm5Y00X09Z86/k7l8wn9SfZ9SQLnSbERGxFSsgFWjkdGUVWlVNpGVjspJvaLEZlp1jxOubLDLlMqIOllecVe/PbeNqYzCm3M/11eyXc9BMmwjnJU/moSHX6RNlUOfiY2JJ4h0j4pPvpZqNlrhw3w+QDssjIc2csGPTckrrd+bt0pyjkUuMWx/Z804cj6jbsc5zpKaSCYrY5M3KjamiLGsLGHXgnhdez60LkR/a1vOdENzh2bAQtq8dmQ8g5unyHJnQJ2vrTyjIKzROSWydKp2kCBtxlmDjbMspVZRjKHZ5MhASVa5OlUzfpd+i9xkgrTBo4NplX2uWdKptD5TktLao1gnUsCcp4aZeaBFdF0mmrW2g1qytnHQi2RTPo6pjU2MjKJktjdYZYyBR45bbdqJhpbKyrM2qXBHNsipvKahZtEvr5pnx45oRFZxYoLFw2KxMdyoXGdhwHXXrDlLwMa/h21XdniRnmmgbcnNvKO+QG2jYVJVRb3Mijw6a5fOsp9rRHx5pzLHw1C/cEVn3HfabKnJdotVsbu9jqW3nKOaYnVkzHhMSTl2zJB7qtIpvkd7KjZYRH5Oy69VKnZLw0dXtdCopdCsirlZnod2t4TKmFZlOZdJaa8zhHJKpmS/rX95nmt1W1Oe10MiW1Fqjq2IRoBYhzF0tNYytm0fs5/GNJhXlja0t9ZpZGZormVVXkJrPj2WgMgxWz2Ug5m4k5EdPLZRYN9DfpMoyVlyg5GwNZl+VEBqTWExR6t0REhm3asvXmpvJSKIqVOCQITfRaVQmyXBwQmrYaGwW1qKdJFGo7Sq0y09LlmjtbyXqVi5SVWZhKSc1HW2ILxpyXqIt2CTz8pjjad1NchPSqa3NoSYRnxYv7N411mjd4ijhZl3DbJfdktUv0SvNIZR4aZ4XHqLil+lM3h3aNKDamJuP3x2xcNcVmu4TRdajqi6c3ySp09iyltauLOIxjBTaFJiX5LNTYp/gm+wnIZoumQvXzK+jqgqlT9xe5i7T1AmTkytQcdPRDbaY5M8OzGsX8xYfIK4Oj6jPUJLK0XUVZGBUte1Z5h+0dS4aa5d0VdhznWYQ5kpib8fKsyYcd6pI56axZVbzDs7uGjDxzVHpmrDska8cJeRRcxBq2NdR5FYO448fspffs1BmTqLzX6EjGajMUKaPraHZsxjh1aTf81JZ6mfn1yrfqkwNaFsJmpGhFySM1syJUlFtCid1TGHyp9VcMhuI7yJs8JBX45TymVMiqhIgliTXppW2sCQeR59coy/RH44fUsxtUl5qEWSW7I5LmpjLNGhaGhqaHRtdpBc3p6JXM2Do0HAhlHBcVGatXJIvDTIVmyEemJ2RqC+uZ97UrAmfL7Cj6uaQn2CsXJMj6ZcU5qpcIDMtpe6SEqwTqmCvrcZmKA2lC6wp0K7NLAoxEBLx4auwTIrpZN02mbIuHqn0lh7QqAfdpHDQzhLr01MzGPAmKh7LbK0U1IbiDVGyNwwhFZ2tWA5bFx/xkOmQHml222gLjpeuoOSvHBkli51pitYrXp5WF3Cz8O6iJeaZLi4b33EaCx8vrR/Y9s7oH9+M5s6dLCW2l+TWWKuSblPi0+Dzk4zpVx2pGEyVKbTx2xFnE8qMmq4kZkxvKl202J5rpvOeEMfo6+3SbiK0EiuQ2pxoL89o1lmd7NcZXezcZe+mXF3tV6ls4snZpKHiqidQVxDUMWSykJ6PMvNZUO3UkK3Ry2IZ6u7RNQ43siNbbJJNreURV62REErO3ClUaVjUUXCrrqhhDKRRERCI4iyxX6MpkKefVM4r2dCzEVnqU1qS7xvSUpVlWGE5cWzO0CQlaFKScN5W3F7U16LIK5GViGHtJMsQ4QycdVraFWgYGOdYKKXYXbBS5fVbmmZv6FsMU/Ts7a7jUy+PzhOfzRIkSirebzGvcfGgR54VtNEl4AwtW/Kql0qlaZmqmSjLqc0L8hMdryIOSq7n8AzJaHHZrKSxoG3WViCw8OhJzamy0GGlk2GpLRCpK9BapyooD1iMoygulbKn41WWkeBV5lBt6DKd3XMcCu1n0ONONI/oURHfzxpojF5WmzVKsdAjzldEsZtar9QObxLQLCfwFOeRVGUhle00IF2nGuuOFNDSVbZolWyrzODaKpyyrSsarCnKZZNGJt0aEVxybHLQDOLrDDJeEGLd9ZC1Iwpx0SHtI/O1rumLbeHRMFqcjWwi4KQbHBUiK3IdMFMhn6qWp021sO6SH9HooWBRpBG1jXDmVNrm3S20H9ZKozXQ8BHdzidPMWNoq5FHrabpDW9i2+6ZuJW1avWXRxgg469NjGPU30xZ3iZg459ZsJ1J1x/rFRJVpe+Ukq5hZ5LYl2CvzvVSHKuLXlOrWkrh3+yXL9eXT2A1YaN1EuxoTBccI6PojxseL94p8c2gadqwzV9WmlbgbpKlDF5WHCuslkoxKBCf3vEapCqIW6OWVVCmW+YpCFmrU6Nc8RdR3bZzVeWnrIibTqIpNDpi51IPpU23lU+YcdplIRGr4JIrcd4f2hVecCoyCktRpqWyaA1pLOcdEBHdFZWzELHnB4oL7vTdWVZNoSVtzbKVMLEP21uaoGVTkh+TresSWFsgBW2aW9MznBulx24sJqHTU56nIKmhWualjybss7NO0tBan55r3GGZVAdtacsR4mIdbWFPb05Si1sfa5ReX2kj6xbWV+SqUfJbq7Eyj5HlY0x06wzksB9Xp8/hNo4YmqJPEGIWWNjlVxusovBy2RCyqurhk7QKbmKSVEluMjBP8WCMXPTIzjBUVV9TJnEjopUkkVLh7DdzZxfTdE418RHhM5Zm8knVGPFpZwntiuCeKiQsGu3UaCq2ae9n0c4o0GTNIGvMFE1PoxBMnxDtXk2R3GpQHhBjpBXdIaUxjhektnSWUGWsIAlKEU/rKhPtF+YfVzwanyMtsy/tHuEqpyRPpV0fndznUfWXGXKklxfPsXGHaHGZJt2RIVJh5JGXqLRZ3bQiUCHfXsvkncohcW2xR9rs3O7X0A6bjljQEiUd0rBoTXMwHSM1ml4TnRzbGKFYo+6MLwzqV1eR6CqR1V/eHOwV81SvHw5in/dzl5Tvc6MrjtQSLJQSnhxbDVFgaPCdTCHvne0hMRDfiOxHFx0bqdzt0fIlG+aoiAWhKievzWhyTZwVUNYWifBkBq0OmW5xlGFV6/So4Nxy22RhKZufkbEL5ihP5eBtWVWrZhwvFilgkNwQYS/Vtugb5jLSniFmsa3dHihdmyDw4GEH0FGop93yzqVuWnQj8iXTU1hK8bCtHkquN3GhGercESGwo6ni1JZY2y2Uqu7x3cfVV6azKKRrIWmqbt1ncR2ncBvzVRLg8/BmDcwtsg7OUqrUBfMxnVQMtHOyVuJqJdZNVSCnNFyaIimyLq6cmhIUThio1A/hL5TqDWnaqyWoMFzoWDOZKNFJtYjuIx6pDa0wZ9cpc21nHYuplFb3FbMV3WllZJbb7UnfL1ndJR3al6IZz3RvCpiXnuwNYCKjLurwVeBj5YyrWmBSZkur3RIjobAkJaEzXjaqqOgn29mbIubX6KlNqCVlmePwk41blljnKyXXGhFiTFSRsSyM6ZPXF+2I0HeV2adR1Axaqqsn6RRwmSIeE671GW716w3o4EZi5G8W0AzVFSamlx4vKo2mWW7VKhmzEMxZWTYRoh/g9hvfFVsU8qinE7I0a2plNLWtJ5RcTrGyxxKTVuvioSJSE9BgnSyM60kilJYo9Fm3JlPmjkybsXnfD2FYaJjo8+luXxDiEExZ4ZMQ7yEvz7TR3VohULKrZ+kxHEuskJ+xKd6apaawKKIcdmUyjyNcoGBdEu6KdNgQDfjY8+pRrM7wmZzMU+5kU1bWj0jZDWQhWOfdMLHnqOHYTSQNjjDabq4pKo/SLpClWSMVa89VXlQYNXBaakfIlzErn+6K0qspbiFHcAcoYI2IIrTq3BftMKFPKOZfbE8cXGpQllh2zFvnmypOFqHhcBHU4yqqDS7fMy4ID6PM7y+KVdsPHRdLo9OasZSxoiHLifNZNEsjMUlqTmXIKCPwJ9RiXlRuHxjZDRpgqIvSNI9Sy7SjHGic2mSb6h7cHVoMLd3wXbOcZxFtZE5b2itkUJKULeMuKTKbyhMaa46q4NHhc0xM7tQ5HNdMY1EeGxeN0K6uo64KI4nYc2Tcp+ghnOxujGll14/fYGdSrd8tFKDZ7Ynm35fuTieWZpJglWgwFWvMl1IaaBRc7E1o01lgLhWOJOoq8OGkTfCHnNahY45fKaGvkWkl69WuoIfypu3QK1Gj3eGNpAzk01oWCSiRH50NHl9eMAodZ9pbnCmrryCOqktj3CLXkHQSEh30le8jaOUvEBEqUvCeYg1QFFtRxxAiLe4XY1Yt0VLrZNakKyNJpSupWFFnbc7oaY+oc2Ab8bSq3JRjTKwk3aJvqJqZEmTsDNWgkKFmWFTbIy2pGM5kq7L1NfGWE+RnKl7UbJQo3hFJo96XKfIwoqzTUY6wIu6Nn22OMlKw16tklF/VHdXarjSUcyyHpVevaxVlHO1WlO6xrafMnlTyY46OC0wlI5nn0i8o76VmSebrHjGUI1j1rqIfMORYTd9F0SrXWtak2A/WKHBesm/syl9yzIleM57bFhSanZgkH9aYMglP2cWGlVjuJlZZIy5iiuMnmxrglrDN4etNyC0wIFZWo9Fps1nQkWiN5e3zUGvO0tuNZ7Hgr2d1VVFv6epPbSmfTNwWyukfIREZpuiQ5mfUXShm1xBXzZnLHyQiVHBxMnPenItymq/fyyuW8aSVTFfo0zeNFF/lrLXU8SNZMKNK5ughdN6wd+liUmUZ0LaxVFJpbReuYFGd2mzUaUsoD/Mv0igT6IvXpgon6G/iziGkUG4qrE4Ws4yvl08mD95zni4xWNRQLtAx7quIs4rSX6r1WeKOLGwPoddrzttbVaVXVdZtmZwgGVXSbnQhXU6LquelSuqV0u/gzV0e0FZiHzIim3Df2suQY1oacxCsZA2wqGyWZ11iYa1fUIbxEc2smRDzocpvqS8frxanKOwtFDRKYyfNryZe1TRaS0ySaxyTXy2uZpOwHTAfCuKzFLEqMJpwJdGX4fHrmy7Y6o3V2+Jjo13OeGIOrpnWi5pcpo8N36zxLusUGw6fU92iYKsW1XQPeA+hVeGq8s5LEN3ioNcY2wuh1qHX1JXIJC+loiRr7ZqMLGItrh1WL6YLq+fy2d9Ui94jI+4yX1yZ253VrhBfTdxIsNWwoWKf2qzJpI8i4ulc34zMrguyb59Nauzd3qnw5Zyk1+nlHc4Zz52JImVw4uMasZXWr20PYWbezNBgkHKnqu0gch8wYqhoItAmjjLtr50nTqikD9RMZaepoVcsmurui+uv6JmsJ6kX0WwqIxnKoGFMHvbYZbQuSwxl154tYaOR3aEojOSnC3G3j+YbaO/csErUU2bvW6oQ105gHq1lbKjjawqRUegLzS1uEFPkaF2yp+Shis7NH6mXFpPVog5V4pPWmvevVJFidGsN8liSb5hKLleYmwqyUmbbc0jaGhsir8/nomTRForiKEtL5CNi7ORZHqkM0tdjqN7cnU1UDjWNGbEU8auXbMti3WgjrJrwzxWwl+5esR3cmGYySUovKSdyE5JqZKRfZK5SmFzxWRwUUU6jsWjOIZErHlXeJtlsLF602k2r2muw8IrV3HEcZmLIsgxbaW8bqyCam2CR8dIpTmGkl0uqGFceK+yiaVFg0m5hTG/r62KlmpwbbrFZ0VEVDeO0kObLH8wmdbTVUlGnItCVqkzeoV1vyuadXRdsHqNVMMyZZJxZkFyPG1o2rE6eHxVfKSb0L09RnOxnkK1P88xWsCTznrHhkeOSaSNOeeE2jRDtzWEeGKDT0lErmqXZYVXtG04YyiIvG9rbbt3tquFhiWNfZ5Sw3e5iqq3L8OKYUi5vzQpqa5AwY1Yb8dsKHy4zs4tkJ+AjojJjeRafIM7s7K0tjnSgDe5OnC2kzWpR5fIT4N8sLV9yLe4VM9gYW90UEVfMyqUOIpJbbPLR5FTplvCZDi9l4MdeL9UXTBwwVDArocnNYDDvTZ4orO1W4lbP7usmYtXqkXCgiy2LLZWuijIbKK1lphEPn+tMsJhvqg2iseKxD0oKpiXurigOIEldqIibL+6vjhdrDOhezQ3s4UomaxC04eDcmjHLbBQnaBggoBNWoWcY8+WrZGhsQ52ZrdRv2p2WbOel1Qrz6osRpGxYKWdtWVyIpufvbljWKuopr2do4B/PHOA3C9owaxgTS+knG3GpG3TVy+Zx4VdiTu3rJmtX3/Cy8lxZbHMLG7gdaBwFYGqlbGsb6enknaulDKdnZizMIzIfGhXbjHQqzfMfElrLIUiT56AtHdwqTVyt26+O3uWR5aeOUtnbYeOlDvAaC+dpHZewU2+rkdtvDWQW2K+kYeHbVpiZLRwfkaOfYCfhcM4fHOPVnWdX52Ca2Wps8WjcpS5PYJJ163WrHzJvNB9UYZSTeZ+M5dogli4nWhMb4p/V7RRsER/V5eedjBvRY6FL9CRkllUOuZlaHxYfsA5n81XaMCHZL6MYoOjoFS8TprGgIXLWmEtO06KvtDAHmloxrKlna5xsj2ybCuvPSo0Z8B9R1l9iJGMezRsiGmrNaxEYaY3WEtbki9erXZgR9RufthWgJM6X0akqHN4NMLoR0g0wIbVtGRosGhdaLvJT8N/v9eHL1lfWs2outB2PUKecahIV3fXjMNuLL88PnGhpW1FqT5jZHZcjzlQR62Sppqtp0xGl7ltr1xjYLtI3rF9Nrx4kZe5vl3hR1K6hcXUnDRGdKSgM1m4pK6weLtfQG95fcB/01igRb4wxjxiXLdaai+IlTi+SkeOkVtaqHiboLlKjESLoXeOja/BdHorVXNKvEVQuVBZz7xeSHBdts5jqsYUp1MiQ3/VkVIotT/HkKC+ZIuGYnGWsa13W7Z/ysmFKEjUSyepNjdaKquiFre9KFd3qTm4HUqAi3FZOi1NrqKQP115mtovoZY/XWXaK6VgtmjbVWHMPlWnQas/nb69Nq+xQK49b8ncsXJpN0neuoxAi4dbIYWKuJBWzUOjbtNuNrJgupAweTI9m1Szs3QmWjVjV5BmbcHGpV6IPYecY5QwNItLM1/KaLZjrVyMKkmHmHc6M0pXtEy61pV9rKCCfY+s121q1S1eJkq8wlhjf3upY2lGh4WF3ZCsgJFdlKVglHTEWbjVa2isaG7Jyl9quJt7WX9qrEhATG6YTolpoZZ1OVtDlMBcd3yXMk3OHqUib7qcWjaraVZ0VVHJcmiSR6+miWm1uaDKkR0vREybQKChVVqQc59JbipqfRS8prKaa6/OhGqhPNGnN3or275TXF9nP2sorc5Pw2qIV7HCe9RtSTlxWVigllyKnlheiLRws1arc8xKQaRmnXfWRa5Tf7DiTU5fl3KScL9Sc2knoZifNmjGumwqbosvd3yDUFEuraTCmmF/QnRROU5IMa2zmHjLWc43XSk/irSvflq3K6tyNyljxdQwMYRWxKqzk54+3Gl2jGKC01ObUlOAXGROYZwo1kJhgFY5pnLOZtg7bYdpHLfFni5hp7HMeFFqM3S5nElgcyWGUrSiX32TIx69PGFqcljARo6jWz+hhE2INyk5Q76IzorI0YPFTK6yoG2wQqNEyo3HWbxPgHGjMMhmiGV0Na9ot3Wh1WXJfFtLSptTZKLehJ5VcrRFhrxOgySQxVhGkEHhvV5ljZdjnG3iXLJy09KcJM+ygF9IS6O4kqOQyWhTyG1/aH+9SGvKjJiLPGmcvX7DYqyMUG7Gwk14lB+xZjKyY629RHxxkShVboKAY7d6sj84RytlQ7yHJ2qlnLOHVnwwF6SrabVQmVJrk8ZkYIVirUzIs3NqIzKIrqmIiMBck2PELLCYsJs9L2vUX0qtiIk5RV7AnEVVmZZJtMCMO6S4gLQ6VU5D1pzNrFPMhrFLoyi3p1i5tsmdksBqlMYpN3MwKqOXlEiLyLW2a5Vrtm/gf49nqoqreJW7Q3FPYX/PUo2eY9ItmZdAY4KocPF9YGp3NWuqaSKtxK4ounhfMtU9ls2hOrIuNXi4qLKnYZwwVjlrhoc5nJtMUHXXRHyKTVy3No2BMMSLRjivgFzKQblGuaiauWS+YzNekqFznJBdYGPswkiP3ltewz9pWW23R8g2L8dowXUlko9Rjamjza07yM3Vc4C4pJqg0EiWWNAjsZOKREVl0zipjWtbS0rOiTCyKtTNv8Rmir67f4dWicKYSLg0u6i+ZdNPiI59XZmXkUfGa3C4tE9fslyshnWgNISIR647zC9IyKubVisyvSRl052rOTBArGlnR4fQMZJMeHGtV2m2wstXl3a9lWrIR0h9L4mov8WseaajZ3Q6wFSZYDpsTGPJijaaj0CTrrRQkmCqPk3Xo4/ZXD9EWY48u4QzZMIzm4OoVqU8TzVLN8WTpjmqPLh8s3tgws1rvF4tVUyJR3QkWJSxK79Czrp9l2CzpllJnXORWM88uN5sya59xTivIjOozmIeUGuCRLChsFONn6y7Q1FaqIFgwnxjloxjXWwyTpbNjMOXXhgwkiyaMXwreXyBdpmHL0V1gJzCPZSRol1umr7MukidhD6xKKi0Ys2eZL9SdabBQyxZQk6Lm823cGpCxG51bcuusCKFnkF/zbk/YLMyvpFLMjaxsqW4L32anEBxz3c2UG9XP7+rjy9Vq3nSVNw4QZxHh1xKRalNqmcirm9dS2pheMWHL7Zuj6GPaUiNJk3Ix1s5dW4/VZ/WY9EqRL/MN8hlxmiQz61Th9ZRpqs9QjTOtleCVqKXfoK6Imd6X6pgT18rNjmcc+OJgFdkyz0kXXmAy19OKpHRw0hMsLeXrIOCWCBTN6uNTEsbi1w2sawfe10vkDSrvnpm0SjGWcdhuIvWcpOUqlWdf2JTRq9owZtToHpOhqGZq1lMVl5ATUuaqMuYdlybjn9RXHXUL0NnvT2jnYuqQ2DBVkPPImayOcJ4fquer1/JaUKqiiwwkxZUv3Ap0qQ+b71ORHrRz2NZX0mJzZmUcU9KW0LDpilgxXRDuZhdj0iDM73eUHJz1HHMIJSG5EpGVmI4eXJMtaSRoD+CUFeSQ49NVFVx5nxLf7wt0hqSM1zNennVOzB8j5osspY8vJTAip+CgbNKWbW4aKSNfUbYZ6laOLNDkqPIUlLDVI5+OLnAeld3ny6JWWiqSzKDulZWtJFbp2SUoC6bZ17DeYhgijzRjEsyeC2LsXUPuImvI828pX95ppAdcNI1j8lnYUG/SdNeVSpsraYwUSxLdMJpQUXIxUZxVq6ybysu0C40U6iq0E9oPGeiUklIS0CTa51Zq5hEqZJjmZafaIVCS1tcLtmdujKlPjFzS0pljrrIK2DNPpYwKrdEs7xQVmPZYYy1Uz1FmamGKnhZTXp4Y42LzZo7b5OiOlNDep96tHSxfs97rtpxWIBUUapTnjWK3Ta/Mo51yXjHtpSSh39SvEFQwZh8wqFWRthcPLWOtF5CUVCUiIzESnjcQb4mXseKYzNWqmqqvJqFcWWhvpmonkZIx1XPnzaQZ3FRtn99srKMiZhzyZ4qyYewZ55lfrBjL7tbP7ExO04+aHPWQElipYeufToswo+9WGVi0WO9Ty5si56kunNfz0rOkM0xuapiY8KRVZ1dwq9PiLIwZs3Kf8OCMTWeTMYqWZ7CvZG4tVVYm2WdMKIuon+eXClKzGlwtjxgsVW2PXoztl+jHcI5pGKzKMxJrpJH6Ji3PX8wYpJhPK9RTXAwh6ompkyAu4F2XqCtxb2bhHxXd3xLoIaVuLGUnah5cZChaokrYpgnwTmboMORmoapPsczULHPfiSTjDTN5IE5RKSkZphGbkuyf3mDvj+cxlTQK9U/VIvBlEPBUrNbZ4lFeaibpHOgZ2KDcYDVbVy8u0/JME+9ka+WXJnCkGQvUYSVonRsoaqpbpyMltB3m4ZXq6JRQXBPZ2+jVIDAuS5xcMUyb1Evmd5KQKiiT0qAVzKFaq7PhLdgcqxRa8WWdm+TJ6+dvomKgrqYiz+6z1u7R5ZZ1cyPRErKIp6ii2mmeofQfLQqa12OoMnVbnVmy7u4zKqhubuKgD+kncCGWnMqa8W6jsI1NWmdk61ow1GBctCedIVNbsZiyrNnXEyxORa5XXV7VYKnQJ88W0rCnk5XKGCLz7fWjpOwo7i6X1VCeWbHqXI4osS5z2ePUbBTnY04LXqGSV8qgKujY8KPS6ZPu3g9ioaslkBijRenvVHNWkaMRMYlK76OLDxkZDK8lVWvO7uLXLpEV347Nba3p3sxVsWiOmF0zFK3bKBbvNA2RGSofrKSrS5iw7avttBMvG5NjnXRUqaHZSSflDdnrF1aoazMvqWaU3g4jjnB1ZBmiifHq2WkTcBGVcGgc3s3XdVnypAkcrqecaZLLcZrt7TNTDZ6SY0vx7F6jMmMkmZUtaiLVntAZYpRUH2BpKlrlXhhY0e+SUa1vTacfGF+sDp9souhgEfCYVqPX+GuMDmEddOpNR+9oV6YS7pGpV5XtbF6w6VSUIBDik5buSWNN3KwwHrVWdeB1L0qqmlksDyexIdCt6heQJWRwjh6jZBxwME4wLyrXZN1dj9OWM0pNZmPVcImw201HawYtJSZM3NEndeTsq6iPo3I44i6glZMcjW6uzGxVF+F2sG5R3FOwD7FLLtJyVgoe5ubj1yNfZ+Ib2GyaV+CW1YwZquOS8DBGpyk0DDglK+Xz2e6t3gxey+9MGNikoGbuoNTcETDhKWmW2GJnnW+HHCwUbhdZFRSo8+30q6EyjKZnGIqPkV1TEmaNTNn0HJeHr9Af5+6kVqfb5Y3nlcltcvDSqmncy2ZjniOvVa0wsFge3eDszpReYxkUkqBoEOgIKvAkoOMmWegSqyENMW+aJO4sh1Poyy8WHF1vqiSQSuOxKMnurS5c2i0OoezzD1TzpSbr9dehqC/qWozi4mymrCEvpOPtWU9lVzPWVa9QMNxyHzCJ5doks1fkSJLYmhzMijPNKwoUrChajuCrmasTEXUsXdcfzG/jFhLOM+rYZ02UWxDQcZGUB2OmWpR026nVHVHyMZAi8qBLpZ7Ih5yqV1vjiyjkc6XVqpQRnmduio9WJ+rhVBi1q68JKmmSEeReYfcWZGusXBkyHqeiqPNYi2pGp9PoWctzXF6t1NfXniRerVDaDlfO0DaQDZJz1QrJ0LRUt5pTHs0VWinWbpJ0+DLmL+NEJZjmHwvR92Sz5dqzW6CPNcxSL+sjC64rEYiiiuKgGDCXpU2uqEtRM+8ZkFFmXJX2aljVW2rxHiBrVm6yGW+QH2Ya3efmmqOUGLA1Txy1lVr3GOpYF3EZXix0WHCR7qYhnuMvLqlYEq0zp2Lesp6hj+IU85yxcIknIKSlqbAmSGQgypMsctWikJpgTpOTiRDjHWXLsmSrkxKn1tTosQsoUUgy408ZzF7lpRmPTqWzrhZeCZZiGFUwLBFzZY3u9SyQttslMpt24B5n1TDLECjZDWwd7GybDc5tsIuTlO1QMUwPlBvf56tsS5eLFOxG7inOLaHv+FQhqFMOtqlWycmaciszTynwzczM6uEiBGRpKgoUMWOjlOqJUmEtMWDU1SSjV4mNmVaiKaFqY6DrliTgbCekk9fsqJsa02Eli1N0TKdOlsxe467V6ksQqQpl6Yto15nWkzGscAebKx2qTI4OMAtUFlAuXbH1D9fdMWn2TJ/tXx7s4ZiQWNItNOHMYra3JisIcs1h0rAOStfsNCAXFBIjqd5kqTEQ6WewYOTglx5arVnRblbU4aqjr+1Un1RyJtUnrKHkD6SZt1l0z3DIHBwXV2RTUc/Sm7Sb5pIpKNBeHs3bL48HsR6rqSgk25sWUWsvM/CR7mWtVi9vSF+hq5qmoo9zFo8jkx3lX0tiyiYtpd9oYUrdq1Gpi2zU3hZZmlCtke0K8mCyEl/x3WyPptVRU5XO0PSO8t7qMjKm4jOSb2PxFqIHrWRZSmbR5ZutTgsn4YkgDC/O5rRMDZDioWuPp24JaI5w7soLqe027hIPCXNUU6uRrk/fya7ozPFhDXLJCUeexZKQIm1spQ/XJ2GRyhRt1ZQasRLvNzQd2uSr9bNQI5e05Q4T4W/pKt7lVxejp2oxHCOn2PNhsaHKpebo6Q7Nnw+OJmmMcVJykRJO5WQlVZOi4tS1DufsoBteX+RbMHVkYWUbZpKfM9mgaGoN34/b3gmmzkjKMg/h6mqboePV3V8QtK+so44ppGKiFY6r74t2TiDHFulv6pDLyyVStNsy3FldZNAe4M6yW4eRE1yvFAlpkew000ob0yMuqOYsTrJlFuIVrpcP7GPnodF5jpcyKmXiiaXZrU7bGw9h841cFiGg4/HvGpFWKO9IUVb0HpMrGBYe0hVdlOwnIOcTNmyprhkmFhUOMhmzrmfToWfqNBjq5Nnn9EfT5FOnX97lUqR4jlUgYJjsE5aOZp8cGi5RULdTtGYXr06m3eIz0GIt3G0oz2wbs2Cln27fUBgPajFfm58xKypnzmNrrWDNbJLtWSvttM/uJB3QELVkDSRNYi1QnGlwGXFecJIaGdjYrGppyxyhtKkPjpjM5JJlMCJbkk+MS6ca2GuNIxnr8dAd8U9zCzPazzLRWyginujw05F2mUsZrMkl31UW2TEeTxvjbZgqV2qd7pZpiK0lcNoYrKCN3F20i9oSlJfsWpuVdc3x6WPSS2iX0KcTV65sdek1a5EgChZmS52Tr3TNLYzaMS+WrfBohuVpYA6RsU3i1MtNW/QTIQ8c9M6PXCGSONcXy6yuaqDhTlJrqpaNFxsXLdMP0kkPGh1ZrrEVli6M1aQbrp5dENDrEhGkZvCqFxK1IxEzptZ0CivtYEdHoEfWDSrXaVYkm+meMdGuccwyKKstD1EjpmkMMBnjmPOnCCdUlNbwbyDVTvebJA1hGy6o39hMLCzTKhPqHeesZaKvMCOUyOsbS+eqpEhpamzjJaxwnCFLXQkmUBTYUGOT2UsooVlX0qdQZpiUpxvRmuYi3nEd0PJvVuuTiCNibRHM52oaWBfYrSSt58+rJihx6LGb1xXlmw/aZ5idEdNPDRXYLN6mUbKWoNYvT5ol3lpRks0KbM3wMnYd59iS2GIs6Fj01JBgDhli52gto6pT1iQX6eKgWZPUmuCR3gnTZytPCShap5AgLGPV0uEV3wrl2J7m4eGoULSWWqOLjTAO6BtyCVXoz0wsSaWtqXInk1fymHTVnEtuZ5AGa5zmmSLYFS7RtlhjXauvl3YLFuvU8a8fGKccmOTNllkV4TMO8qQq3eHMjlLtWZ8tLo1QqvqUEp9rFnFY2Vyx0OhvYE+VUJecINMiWNxdEI1yVc1hblRhip8x5bNb8+QapyqezmoXFEoqkZi307BZ2hDnIG5tSU4OaJqSXCEbn6MVYWpN189r6KtqZZ6ZUxSTmzKuoRwfYmJtqXQoD9iy1LfllZB3mE6UeaLkiuKwWtvMGKJmTWWJqXOn22GMaqzWMGhMTRpbWrOjJVZS2LYlYitVX7WOmiLU2o2R4Dhe3Q0gCo+ojSYnZPbkaWlYetOO8GMxTMqmYWdP8K2L7OtsjuOXNA/d7hpqB5TOdWFQ7M/THSByDYyeYack1SjhI6NmIKUhGNdjly6u3Bgyn6wgn6/2oGoK4VonKxmv1qCb1mwpdiCTpo8x4Bo0MORSWBymKiNtb6jV5btT4DFXDmrv1FGwqTEcmlrbrfLcYE5xp4lhaJttGSvTYFR2MSyWraHQqq6e2+DrM06VTlaLsPQOGtFV7492FGi1mHTQXFgaJhBanm4qMAZpqeMo868b9F4rFrDcH5DoItWxUdd2oGgvo0kq7QjO7V4fGByxXArbEFdcyy1k8aiW2WnV42drpAcwJo91tKKgLHDTLmQUUnab2pIW7R+SUqaYc9YvN55VYxjej8vgr/lTsvFUjlBXpa0KVOiTb2nS6tyX7i/i4egOoS5xJ3IO5aofkJ2Qoy3ezGIwVbNi3JeY8Ks5jpSvoVJUjJ/PJLSg5Ovecitrzi+o6V/bMaTQ0KFzm2WIjBulEpcr9Wyj6WMkrxtN1qVsEakI2M0hoB3KsGFL6V/oI+mU7qDV24703RtS7+7V4SrYKmkNzLGS9TEZcW0gJLRMUFs2aZat2BfcaNzT9cyl7mpaie7pKpVm7Ytb2zBgX9seUm2iFeqZZ2xI7DCtbo1hoBFanzFUFDDQ7RZuG4ysX1kyIhyftamPqS0f6BCW3pwVN5EX26DjaqFgD6EM723aMB9xlph5EV+PnzMpL5mtkZBdpJOX3SCoTt8yrXVfEeZt5GpblqVcG0tqYd2VkSXaWd+f7p3M1KSeKypTLi3Z0SqQnGf4ElYVVtGYJ9RW1ainZWqP66QjHfWUkGLWFhMwchGlEySl8BrqsOlnjZfyynESSNsqKiwUCu03E3PKTWsW1bPu3wjyWVGo6KyMIbccHp1z3A8csp3VcAsa7HYfjRFUYMpyKWFdUJcV6JCVWDAfTqURD6nYS+axVWUcI29UlJGmHVJvYmtm5l+v2K+dqOZjtJ1nipbuSguvcmJcJhirlaQzz1DV6NqXaNmyMGcPHE+TLOcXzXIRaVfW0GasGOUaoGwmTCqPK1XZ06wf1N3jK3CMr+nmSrGhDc/XKaqz7OoqCtWWZzFSGOXllFYx1ynLWR1q7YvY1RXYtiaTaVyhrSfhmaZJJhnnY0pQCpUjcCQsTGWb0FPlGpVin5zwWW9MX1kcbilmauLT8mCTdpNyY5tkn+sqmGsU4NJRXOefreHfMm3X1ubxZGvgHK6K6KubZSAnHvKuUhXsbaoeiyOPstniEqXt5O1PmGMa3utQTR3fYF7Vcusea64bT1/wcVIjCudvptlM86ZjC9rjXdKzm83e76at21NoXOYaEafar9Aa0i9ZtxfmEGCnJc9QEiBPkFnXqanad8vTs2kxEhQvrtxONdDVeBbkqQemLGjJ4NYmeZE1X8YrV8iZ816o1E2yWCuxJ1Rm2aMMoKzgim5n75YS3VKtJ5EVJuqFJyaaL3RUpdh1m7jpUaRc7SvvGZ8Z8bDQiVHLXeETWFazZ0mvaSUH4TGWI6CrhsqVch8xKSW0IWohF5ZR3q3ii5Jt0dzm4O2NE+n2GaLUIaT3aRUN3SvedeOzT9GwabRT8TcPVqnwWKPrnJWsEzLqUR3KTTRtFGNz5e9d0pmh5BKWkaxuXKQpoZ7P25FmzlkO1yibkG4rHOyeGK+n9F2KptKSVpBZmvLpEiBOjqEu1HIjFeBWUOLd1+mgs17ZOFSSFRRyD2sw3nFsmhxhqJQzHBZbzu8UVOK1aSCVM9lXGdZqjZAxMFSic4+ejczT+Pbjnp2pKK8eJ8mpakpeVu3UGGHjIRqI2Bfp42QWdPQbsU+tn1nTMSzMpZHz+u41eOBc4+KJHdug488dj9mvZEyZaiPf02YwVo0Z5zX0EhjcEhErneRcmoveYxwotJN0zC9amkWhrw+TmuUPYQvOUeHMk90IJ5Eh4GAP3taTc4+ij2vdrXAdmaEXnaDf2KsT02WY5OCuWFWwNBcQnDIUlwuyIBpbcmVGmiit3KvcaS2ZcMzcb5DLLyfhrinko+Mt3HHPqTioamibqSIbJXEeUBTxoVKLjScOZ8twl5HWDk7Z7m7N5XGJUy+bbJrr02LwHYrMNAwT2yxJmmMxHVjXkNnX7g1rZ1RlDpzp0bWlKVEuH+DPlGVu4iMQkya1y+GZMbNOIc9xD6JT8BGx2iwnTKXSW/NNr6QV6V+Kr9is1lQybEgb21rIcRnSno06U1DvHBWaaupOb2xxXhxO8jUQKY7ZUa1O7uZOnTGUzQyPjs+c2E0uZ44QUBjn0WhJ0dKXZhELFPaqoCEeENISj6Sk8TYqpVXaKGKfzClpV/Pn3c7QY8wvoKfSpFcP6hbpx7CLp1AZ7rCJkI4QNGXbr1LKiw8uz10143ERTmxsotqzZuKiFNFhEdPrlBtQ8GZT2tZO8bDqkCxMslNikWPe0NBz7h8dE2HcLNBpIYshIK6M1NRrzx1yWk0RkScqotIwKVthEsxu9SR2mRjxqyyjUVYyD5WU5JDvTyZUrc/ibXjUltCUJcruMY8jlycwWduG0WnmFV4TqpZPNRlX3c6zVxpXZxR09bYo5uvR2/VScJilZwrco4rMaJuY5SchatCYs29lX+wqTq6eHVLwK9DPHCRs8XEJ6YqPVd6llelLr6lobhWvjulvDano5GRrJmPbrgk07lVx5ePs5CfsFw5mkYoOba9f5JywXbJfkKWKkzXk6g0VlmPKHeP0T+6LILDIbg2Y2PL4oshVsq9PaSc64ZqWkLPrFy0qVpQkcaAvIylkyWyeJZBr3x6JR/JL3hMr7QzWlzMO0zFyGp+S5aciVexWZC3dJeehT5MLnyGrItalEOZaE53ZohKs12Zh0SqcaA+wb1z2TMsYHZKMptiTEqax42ekJFFcbZ6MrFClVpCsFk2t02lP5OgWmaISENq05FFsaJUoj5Li45XYIeLr39aykB3dV16f+FOl9yXzj67p9GtyJigu1Y8ZDYy19fBenwci6R2VlPUdEKkhJRZk3TFhJCtiU+qHL6hi3WvWr2guDzKcFCgKbLRrlaZZKlJwbu0kaIzx0+fS5mTlXCAc5pQNKh0om6gZ8c6VI90ko1Kt0WLOIRFuG/YSpw3pjdgnF+tyFtzWm7Xdm+xnD5cdHOxq6itSdHgPVOaJ4Z8pKChJa6ZlU1zlzxIKcxNkIy1k2Cfn7t0apZga6Zql1ZgaHOJhW5anqgreb+VNa5MW7u1SY8kZ9PZr2zfRmLR2Z4tWp6rt9PDUkY8dW+DotTHRBwcQkBBnnaUaKDNp2ZsdSSyUB66ancysnu5mKGlKnS2R3U6pk1mVdB+hYeR3kmWdmyJwTk8tlFCxJcdpklivGZSj4hTLdBzV56DXHpoK7+rqWVgfDTBmbdNYU9fWWzKYoVUdxypam9YYIXHeWWMjYmySnQ1cspuK0d6kHB3VEvSQVXRryW3fpiPlV5QhLZtonCtLW2nMzqM2aFysL+jdJygp5nVWmm1syZrWXGGeTWRjHB0WC5ESpbImKzBYUx0dJN0dSraljE9LsrUV9I1O1ibuCXV1I5VOmbFp4VdhUps3kE1aslunUavdFWnakiVrtXjVr5didE5y7DAMWJsgUdaeVEwhGR1zX9pftEwrNPNj5xEdJlaO0iSt1quxk1TlmGBJDB1u4F1cLeHSzW/SjRqYsnFQHZcSMdvcTy5zps7gTyrNsGZtmiBF6CzPUGXNaqkrjTKy22nzT6Tg3a1iIu8GMRswlhxUYqxs0ywP5ksmn6+TJCio8ZIk0e7qFh9f3DCecBde74uSMnOSHGSg5I7V8ZRqkm2rY1+M2GVcGaAx3Zms0zmUIirnpjUx2YkfFKQtTWGr285ylq9QISPtaQdJ7A3g0GeQsnNnW1AeTiObjdVqTojOMPEcm1Xortnsa0sp8pYNTk61Epmboh1lT2MaT1XTDbBPlI2gGOFPl2rKLymgUbUkTmd2MlzfHaKpzyAUkqxhj6+fbukRm+9Rtfnlm+XhSzRTUtOv+WSXshoNxi1sT4nga9vxIccK1Bimy+AKEOhyVJlS0p4eZuQV8F1UW6KwIhGR5dzjLGzbG0tx2wbhTmTZMWhLhpXZpCZQkSGLT+pmOFzPVS9fEecr993RkK5ZGlQsKWkesI7T1a3RHymmNI14ZZArooyYHR1UF+FbIHQrcBaVYZvqHKed7GDWtYvXlNgmjhOfK0ih6CeJja+zagmrZXAKFW9PJwuwjWD1VRxmGg3T7KIwcijtrFTXFAwQaxMk51vmzA3lUWnddA2kil5RW13aoF3ep7PicqSt6OqpUuFXL6wIdAknYmKdnnVy9maW4/bNJ5STuC2dDWKjF7LOEqwc2GiwL2uuag7ojGBkHK3histbpuJf5E5abp0ha+DT6OwQoZjY4VYrbqWUCNH0TDIoFBLMz6bqFlxq1mPeSjGR3LhQ8JE2F2Bc8U/YlXMlsqWc9g6opgtRbdYobuHjWmBmZEuwc9YwL0znoZjRlemaCqXgjeizCOuaLhwUltZTHdnXmxnO1R+fbKTnYmEZ7BvnS6rJXnFRoS/MI3BLb9alsA1OoJzla/d1IArkrmXV8mvYsNWQKyMQWPRykFWPkOXoKlwecfWW06immrUhlQwNdGPSslDeiCPN63B05jGkFBhRY+Ucse/pK6nn82zZ8E9STyrSrg0s1xLu3uvybNizJxXTj52jkWPvGY8KcqIMnw3QopH2KnKgm0qpsmsWEMxkKM+xyPKV29oLp84xEAr1E95lchOMntohGqugKukwrzCmEZ/vZ5oSbSviGJRmMOiNG27R2Rgz0o82nRg0FcQVXorvXVvs1InwI5+tFDStHnKkTPSOYM3gXHcOj22ayuduETDxlA0pDzKtpl40W6yn4PRVbzJvSiclWfdV47JLbuCpoRHZUlJU0mSeNN+taRrRn52k9lKTuRaN3bXrK/DcolYuNazYFRfPZXSVGTamnuERjnMUbI0vD5PPNHMmUWl0EusOiKZwE/KXnpHtbqKZ1JoVYWhZj43oXa5qjTTiaa2qDK5TZdvRT6rSpi6jNg+lMDBLh6NuqFE0lCfjoGQlrySZIcml64pg6hUY3xZl0WxsnyWTWHIxokm04knScRBup85gzSJrVZKPKhVSHledk6BZnV4o0muJ695e7hKO4moK9aDjYxKM5EwYGTBQJ2EnF61r6ltxqonPZA8YEiXmzO+2U5gtl/KgjqKKLS0a2Z0oJCQYTqYimxpyMh9Y69CjI2JW4iIZouxwyhjtMjImUA83MaCSl+smjB1wbxDsdo8OnlQhnp7a7E7kl2ntLJn21Ry1tJooLCMqkWWTVNbilCFVUWYGbQkrCN7LrO1PV/XY5ujvC9LdEnfTmddh0uySFyBXH6mdmKYX4Kyz8qJwreDdHmYQE3An0fUrmp4tnmOQIzDqETDX8KGkSOwfJct0Tmgs02F11JtpXiNqzaDj11vo7SEtkuNj7ikr1K3r1LPldOZNJSRUj6VoKozxIRTrGJpRnGVfEy+XouYN66mQaI1RcEykdfJdKdzoZV8kIZjN3ZlzFVSb41FdD9ovimLvVNvPcvIdLZJV1Gpxl1DX6DWzVjK1JyMeVNkqT5Cpq6FSdi8lkCLpsNGiXqXQEbOVTetWaxIxbFVTad9p3Fnl5hGmjRLLrm4glx8KVpruDhWx3dTx2QmPh/HxYxdKLmWYT871k2r0EOia1aySYbQf152QjXXZM06eHd8zCJYjboqtI22aMcmcF7Q3E8zYkS7sqaHq5hFfDdmUjHSWofKg8xkjVKrdTukPXKqebdDg6OHoJs2e3cpvpJespCxh0BAj1HKW29Imopqth99R614zLanL3QkQ0e+gNGDUGKUkFrDfkFra2CQQMq9Oj3BYZmuxFAnkcmnVb96yznAZns7tF2RPHK4e5hDU5U6Uq2GncPaMtNzOGGpejJrLVnQT0IiesN0SmdLtj00v6OVzoLMtTtWy0diW0PU4XC1cq6Kj5GxSVKnQ3ysqL5jl7pIyIdROkOaa7iiKHO3eFOcLixt2XtCp7tAdV3ld1Z2VmzIPqxnyWWzVmKgs2dmsZs4u5RLKaaJqY3SWl3UOKAfz49mTMWZaFpVnp8gSba6V7GvzljfLzhBWGLocWu7b6ufwETRTiLJki6SeLdOXbKTNsNyMFZ63qZ+nXE2w5VtsCx/RiWCjpR+ry+Yb1kbXbU3QGtHvHOeocRELER/dH4pSWO7uIGoknyP30E73dlziqKYjD2GOCsuKpB8ZJV8ZqxxfmErZ2qFv4Z3h57Lr3W3PluFN7yCX0xASUxdX72RQlzcfzXGcXesxDSEaZ4XwhuZh4Zk0V3KTX7CQVdWv8k8f2d8KYOdmX0uhI5RhIQ8Ni/FYKCjMcJJpXVRrrtUNy7HYEBBrHmTK3WYXYbMgJVXL6KEX3eBhUtpWbPAO2OrNok0R318eiEtqaVHlc+7PDujXNpuQl9ohL2FS1tiVpa4hy5mnb6WJUGzsVlLWsZPZqyioH+9xcF8LrO1YpjGIy9cXKJaMclRy9PGlYlppcTejJGRqTFaPVnbbVZLiXeno0pN00CNTK1uOU1cqr4yI1FxQN7TmYp7XJNzbcqHTjapUKakVkzFoidvVsHErUhXZzuwbH5qlUiY4Vtu07KhjIhXHEFIR4rCXnRdUt9NPjSNZIxzQnJRQ72ViGNDPTOmbTrcu0TV0XKIJarJRMWfeWdod2iJhzVFkkxOc2V0m0N/s0VHfKOSx9VSXy9TnrxZk5laa8ouanB+SjXIc7xetGxHLa++dM1Dn79TJJXGwGNydZhpk6080JDMaIqBnNGmp104NjPWtJuYJaSsLVKuUmaQjEZdc2dD3bFfRbvKuo50xtJlxLchRJnHfI+MuIQodLKogqosszSdgV5Qe4TIdsAsilS1WIeTL9Q1RTarwCtWmryaaaaYQd+AiG03R3nKXDbNZ5hOpTitRoZ9cIumWcUwoq5OPzJietCpQm1U5W3aNF1lUbXnQqdIwWdSs51tqVS/rlOZPbqzh7yTtIYhMoy5qmk4roNrZ2Vyast1hcVWvoh2W24sgYN0Y7bdbJdsRMbMqJwxm8bXs4kpqV6/m2k4NmRyl6OFHnbNN1BjSLy1XVzgbCrEvanUqkqWi5qVXGV4tJ2NjXJ9j52zzWmafkFBZ1fHJ3yrtq7ImnrYy1pjjiA7cVJ8nz4+QrHBT8KBoJJ5imJPojkrS4+iUzd3j8uSKKemtnq+saZbjsxjv8aaZ8VxSb3GpYSQ2F1QbdJ4t4KfpXNBI7Ocy2xnrKVGf3A9fkg2O0u9xzrTKoHWo6AwsKexKo0raSpKNM1WMjB8oUqBnpmCe2eaotxlOVRuM122rzjJkjvCYJw/n4PR12xhlC96RrvJfaUpSk17zrZPc6BTTbKnbKI10MiHz5B3T8l8cNV1Pph1TbUtRMChh1h6Scxf3YWLzHDVeZ7YSHyySlrENE2yl5R+TsaBm4JjklJvxSRplk3ZfZaVQN9GVzeiU2KKokF6gEmpQ5Nj45l3g6pHKj9UwUI2oV1EV1C2WYM5vHtiw5Oj1Y9zS7Ngpk60RkBHYJdUnKWuc6jbl1WLW3pqLJtIbdfHNs10Xbs4lrjEWH4zrC7gVmqHVYeJTqR4kTu+bTOpaok6lp4tioF+Z3WOzFythFbBlErahjNAwmOtm0R1kq5IPcxCrJqKloKCwEtdKlOelME9JaOFeqipsmvHtcA+U8mar2O+tLZyuSWrl4Wjwrkv1zxz07k1wUi2JR+OO6CMUSd5M7ZBRnHSmUrXipSHsIq2a0GQU9+CUpw5w0Jyblm6ToK5d4zLqHA9OG6ARJ9BVTbUVD1bXLjV0Y08ySu9go5UMTTMTFW2ZHaYWLtZSYqxfW3FbFGbfL6YqaWkK01drNJQbWlbdkO+sCJFHbqpcj+D4UZzWHa6OCeuwVapVkS0hTlyR2DLMoyNP9g8tCdiboCdxGyBw6bCeJyzhK41b7CGQIhGlZY61bC8P4a+lkZhkK2UlqRyuCttr6iB1WpWu2VoykNGqpmuL4J9moqMYi5XX36Mj0lfcUaEak+MKaJNnYWYNMt0vDHNo6SvfKCPi9Q6lZ9ju0N3WsJQW51DcDPIaKjTeTy+W11fTV+edVq8Pym5SolnNsOGZaYzQcjMTr43kJFauXkucp5iqX5WrkY6ios7cFV0rEllU05WYShJrm5aVbtWi4/Lope8e9lrNkhCR3Keoy1oj086hVJK1X2zZ4WMq6WQtIyGp2yOhbGqcXNMYcegY3tlQ5CqLcqdnnCCMoN9sqeripFqQ2+bnJehpLSUesrXSs08rtDLUlemr7y+VSUZXXdNnTFn07avcGFsk1ByytKNkIWyMXZjulNWf1wtoKNflzwica21ybAldizIrVxDt3MuJdMuh25aSovjoWtAR9hEW1wugY+re7xPjjdaOMdYtynLYkyFUq5Bkp0us7dxeM1PmqGAvEejm8crNoXGf7I/Sc7VhTuIa0KKdWVYeE9J2r9PWb1GVTC6c6xXbmE/Pq114GCnhiikVVV8nH7DdkWTokSofrHJgHpixJFJoX+LZHJLrzqGkJ1wUMTPWZS+VJlQm8NQF4mCNpQ/em1KkHJodWDBdniVUZcoeJp8U3edjCxmNMMjt2OXs7k4LjxIkWrFKjelILa7rb+UrzCOfoh4fXDFOIS1s8iTt5eCbXtSK3Giss17Ndlm3IbQQtlfzKOdRJ2RwbR0U5vIjXolw0LJzdI+Mq2shZeHb3O9w1F8Y3KFqz3Kh3YorFWUZs5rbrNJbbxpKaqun2wu1GXUz1d1ilJGZJReqyu9kY6QrVFpQ3SNrIq3LVSqMbtonzbLS1ucSpY/iiyMt65BXEZLe5BbJ5l1jMysbXvNpb1vilx1TFA1Ql7PrV2nysZ0hiZurTtshriBt0++d1xQU2QlnrZgp4JEikqKn16xr6E3LZBTQ8NOs8t4bjNiNmG8tU9yIxpbfXOaoqCsV8WDcIspQLmzdH++UDZUrjxiJnaHZp+yjB5Dsck9w144vTlLXMCtiJV9Y0Y8QVGiladHYZk7SIK2skhLRn1hY6iZTr84S7mUblYymazTWajIRIJ5clvdXayDS03FP5a4hUQrTJ2oUtE/abrGFay3jJY9e7I24bXPTGVNdzJnuLo1gpy2fNO2fn1COpRrw9WbMUBwp4J5lJDbTX8/isxqk3qZhZukQ2Kzjq1yhq+eXI7CrYJccUeVU4J7fIakizOZdjd6hBmbkH5kRmQ9v2yqznNbzZs8YOE+Tk8+akCrNaeOdVlYwryBpkyAZJenRzg+YcnTaXlpqWej0y/Mh2VZm3BRtKbDQTecx4GoxaA3Z66FMkGGmLrMSlNSKlWAnmUsnFWPhqqGh7C4Nh1rQ05DO8g+e75MRdxnJ4Alwjicmo2ddVHJvVZNe0ebUHWKiaZ0RK5MsXSESWRDRFeGblg3vyo+ek9RbzdZeaN9oZYtYld2O3W/RqVEPH8/1m5DqYZ1PZsjF6WOmCxGvYx30X8mPWVEqEFPU1vDxpCRXEfHa3fHqqnFn9llq5HDtrBnr3mcWMllNmmeZodmVFixesTNc8CNRqBarphSmrqRNVnHyGxiTG1oRTejpsA6sVOtWNKhYV7JP0aHY7qnS7NRmsZrmS9qj3+UzY1Mwi50q2h1ezOrSX+iaY1PIWKqJF/Zij6wylA/eMLHjqnRbMmT0bZga01qhdeBmWh1zaEnKNO4djbbLCyppsxFcn+/smMxu2+ZU8QuSadLhNWQvLpyRORUcUGSl5WwVFA2alNVz2KDhEqel463NKRsc73FtLZKQbR7nKlkbDFBO0vXK8WNdXxfY0lLrkShVUY50j3Lwz61tDSsmTZxMpXYdtV4PcuYltGxM7vXyn1NkLN4Szg1gD9lp7lbZlpmps++wWWSpV9aZ6VlXqBzpImvwJ9QR9pqlc8+QtqBfl/fc4eGcLSNrWDBt13bg3w4o5a1e5VDQZFE1V18pMOHeF7JY8m9NsFzqqowtlXHS1c6l5manyuCwVxci24zqdhXWE+eVKGcTMjIoH9De503OORIRdGxxI+Oj5NCjoBBaFugv0aMKZq9Ry10nr9pqVxgeHmZLUWKjo3AeZ0uQ4TLaVLMijh0b8ZCl4RYxGqDsaTNiUKFgGXI0rCBHLxoqJh4wZGBv42jhEacjcJPbpN0dClqopzAenykmHVJJ9GZlo5re1Qvl0pdiKsuNJJlpU6YZkmJw78kxLcstbQfeqOUh1RTXU9MoK81c6lcejK9vrBXvKK7Ndd6OVdveZWgklh5qJc6uDiTkWxycE+kQ4BMi4Td1bKgSLutwkA5FamNrmetHTlosS9VdrG6c1lKNdZbpK1lV4GTcTygtF6BpZOvQqtFiolLKmFgezjlYp3gYjtWQUJAV5aQqMig2kl8eMVvUHPSqEV2wzuzjbZDy6OyRV6hWNdJNDIzZ3VVyzY4uENHrG7omD9pkX+Zv8DIkTaAg3RgNXM3wnuctjeXvpJa09bLdDqNOLJLuoZmUJXQaL7Ko3o1R5CkRmOApqwqmnNlhz5ZzFFXdk+gM7q4TGhGKp28fzipr2BoHc2RQZV7zF6NiUpJQWG7o7suuIfDd4UvIziEUbeakHfMSHdapl4sOJFWMniLvaOtorsz1llaNYMvKbY2oa1VT6Wh0Sh8b7jEUG9OMFpjeaa6lj6NJ1hFnDO1nGXLaDZLjUeZUICzOFdVVVrUfULYsU++SzPEv549fm5cc88nIsinuGFHeXaIV9uqor96hKCckXyFKlGBdLWkYnu3w71Uxry7crlOaHxFY8SGn8FjdNJ0sKaJRzS0IqiB1rI+M7lj2cp4nVdhP4l6ekmmhnjEn7ipSaqkV2pfl9F4VE9YzsWdZD3J1lCaTbGZfKqnnYaxo5tQl0OcQUlsZ37GHFmrpNujR0ldZK2B7WzvtYi6LY2QoDhYu4+oMaphvFyvRkIvtqRMN9NOYJSHjHiIna9WjVZGlUSRUJtpoFAqUaFwMbgspqa/a6SSab1WnZayJpO3VkuKLKmTppuSIMRiby+7p1J4Vap5slVXfuhZzF1ciYWZhlBASnasdc9joiNonYpKXMTM2tlixC/ebXWtj3U3br1hyT6hyX4zxoA2t2W8sG/ZnKxSUX1aS3mjP8vHvLeKapM0cmeQPaKKO7E3uXdmQKF8Q8wuNty2MyVHzzqORLHCkLRpbn8rYMqgh08xX1/LmiTCdIqBqZA+blBmX83Wojk82jasb2sxMMGDfMGdjYZPtKaDNXpZcUlFxi4vQGlSkC+kmk+TbYa5sFM1uaC3m3FCmjDNNFm/xD/PtYdjclWtdEjXxIDIxGu1nbegf621nISkZXdCyLxto4ytgJSjHli5sHOiO49qJ33FUI1+N8ws1sJ/Y4amc1NIXb2kpilZYWJ3PT/l015BZUc7z6RsNMhzzWiGWyxHaUSPfk9elF1wcrtgHKq+dD9ov1PEXzJES09vlFd3m0+2QUyimpyagsJXS9FkocykMUsnwFBg13tNg1mlxzFxQzpjflGJxCp3s5U9sjqIuc6uP0jMaUKhfM00hqmupcxeN9nIrnNY0KC1Yr49co12oD5g0M0lPYBwlKFhR77DNjLdOZmz35NhoCVfU8CygZ57nYo0zIBNst5FeY5UudGGWnI30M1oQHZntJ2FW0FnnGVcgFlHi7G7YXqxKqFvt3VnisRhuKmAiXYklFh+0GQynbZ3jreRoixYzD3Srml114tOPUtxTKhvO0Hic1BLnJxvrWolRX26P2qLal47PmN9ij9pUZPYk0WmYsNgRUMyNWpWv3igPmhHjViskVxuPMTMp63bqzFGTms/lKcsVJhffMywQ6YyZmHFrDZRP9BTyXdBTELIr69rIHyUNk4ylJU2omVR5LHLaXRyaLRtnlO2VSSEXFyzy6lLOjJ1eLvVVHlaaq5+iSN0eE+Two8ws5JJlqDTN4iRtbKItzRWycaUo0qAaUcyaphPd3djNKtwrpxtJSHDtJCnO4R4SWFEfJorPFG7sIRqOzZWkkUydXY8fEs2HcS3eaGQVMdger/Bq8SUw6I7ko7KkG6Sy8Ay3YdaxpQ3wdhPtqOjQYCIOHlP5WVouZ6hKYiaVTG0hVq1bdqvebh0V7KKPmmRr3Y5sLUtdbKeuzKOPV2qM6OAUXRojK92iHUrmj03g83SPKVCfWXKhG+3QlCjwEazN3l8MsLMnddVaZxpTaI5i6aySJmXe6PkaZJ+UkphM3hQrXhaRNlHnF2NXLkyWrdCZpDaUa0/1LtqRkZvV6DKbjNCQaPIxkoycJZ0y7VdiUZ2FDeOIFE8nlbZU3lbdJW0PWZgN+LgQ7orWqRigZWvYbplwax9mzi8b26OhXxtPLw1e0+1uVRxoabST7V3yLdfgrFKVSthi7lFMai3tSF1v2pEcDphp0K22XN/3Xx/XKaY26k/wnKMj9S9ulmGrq20N69ZWYDHmZ86YEBL5UF1rnlFYqe3gbl+x69mKaVTrdaAaZF2O6xZinhRTziePUXL0TmqaUqYcJCeh4MwwZHeNGHGxkW/Wl5ya7GQpn9mmLOaL6sxhrJuRLJD7DqIY30ewZ6Tgre5u7ReIolVN55QPWBdo1fSnFF00JxrRpKsxiU2y2FxhJZxzFObSb7UWWtEIZytGorSw2Z5QMGypFCAZaVkkkzQxYW8xhsQS0+SYHmPVnc2u4mRHB9wMVSybrzR07UrR1imKTR+R79WSzxtMm1M2ainji18e3t0xTyhKn1jxEZ+1FM7t4l7S0hBPXBJbN5NvlJM2EiMqmTAlrtSmV3BbT7WWjR8NqVHRLh3QkSX1EKvKSe4i7JfjE+E1c+DnVxIkbF5gnq5Ult7yZFfOkpRf0bGJcfFwBswMjp/NbddwLySVcamXX2nMWVlmqpvQ6JnqD/bertRU6I/h3NowsWWS0ZgrzTQUSNhP0ybTrx0N52vg7VXSJqPZ3RCVrBDTT29XsSvdSM+YylbUcyEvWGjKV43kp0pQpddUMJ1qLuJasGLZrA0OzqPPUVH06HYuCesqshO3biHY4kjX0zOebfAbnk7f1Egk9E2MzKOb8yHtnNnuWKgx0xMhMeaynpUeie9KbFhda00g6XiTUOyp1GNLr4nioFf1mzWcoGKPsVBamQ3PZt7k6g/YqedcVo/bNuDuliwS2vGNY5NZ5SAkJyAw70wW2mTj8NBzz+mX7hmuUQvqMHNs3ZvxHtetkGo1ipBaHXBgaStrL5FOEhEgeLeYKeSiSk4UleFebGrOTRIacmoLayDlMcsbKbaOHeptco3tEtEX4xGmLKNRyevqbq9fV8ps4RVYlu1y7K5KI8+JL2YTlQ+wFdziVtqcq6rO3iQPJJ/bjOwlymlqraPMUxscL2oRbqZzXmqqDJdS27N0U+3g6fVsWxDu2mvQ1BIopKYP7IxR0l0UqigPTJcX8XAOoY7SUZ7sUdPw42RltieUdNlgVXJRJyTOLeVaFPXc1OXdI1+nV/UoG2IhZeHtq4pdauNx5OeJj2IuU1oolGAl4Kf0q1e0alOo3JVfDFxsmiqYmuvwJmJslWU4beDK7a8O0Q9NFY9cl9iuHNgTktEa2+nbCpTxGhwSsKG21msNS/KnTBhnVKSd0K5lG+bhHBhT89CsEjMUHszqpZNnNSRsnBgcmLHQ71Ri2bEK2CyMsSSyJ7MNqCNeURj2ClqQ2RJR5OlfadyjlGsujSUNp1aNzC/v6s60ilbboJ3L6zKNZqIokIzLY5wS43csax3w28tvMUzULa+VZl/exqcrlCZfMU/o4llr1J4gzOElrpRKLRPaCjEg55GK5FBQ9RfezyxXDzSlXd4s4M5rELOYIe6zT44lHdIxlbNNcFSem1hvGylYk1+O2HGRbyy2DJSgN5fbky0fYZsbF9dw2IqzmksvKpGOCRqc45+tll+z3A+0swtnCXDdK5XZ+ewmD6mdHXXpzhMfaZfnMu0TcMpXLeHl64915RlhXzCYJnEdUdtnYvAp8Oqmr7ArJM/RiLCiqhCuHyodoPZZ4DHW7hcka+lgn5Nv2eYctOolkSgnRvTWcG+zUS1kHRTub61U1HVOZQpLIGNjabVk50oq8GUtTN6slOfP8Q7qponnp6BgDJMb728tDreueKZzdNI0Hl1L1dc0KV3S6OCMz3XImmcrWRosHc5sZxDg21KnIu0lYkvsIGVjy+LosEZcWVJWWthtsVgqjaKlE5WPbWUd4dHME2Nz40qw75jMJ6qbWedY1dMqnhWiKrU05qgoJUjZD7RzmicOI6+SzhaP+BBirh+cUU4mIZnSEJ11UQ1tJaUkiInbZ6mZ0bPMrCPcrTFRZpU2EpLi8M9pSGSPUjejWaRWrNdXYHGaLVt3z7Igcpxqq9vqJejxZxriM+dt8WsOmtGdbPZTEFMdJyeYL2hrLxNlTlUTcBsfHqrnTyu3qtmgSuoqXibeyl4k4+eZZVXe0Scj3lrX3DLUzhlk1aoYGGDnWHRtn1zdZvOvYY5zHjKT31L2Epsk3erinOGZ6U3oo9BsXBtglF1wFkzMrN+jWwya91Ih2Ghs2Spt6QyPULTRl25jTsxVXiiroCAb1ZDhEFoQZypcl5/xcdLTsxBkpw6eIPeWy5ZJ8qMqUJPtWuoii59VnBcZnVSazV/nITTXpiciytRvKOf37NIMkS6xGCaOjI5nHG+HShVYDJ3mb5LwNGKkXqonKLIhY84eEStnSDCQa0+oVkwj8tKd2LUS0uhaqlCVldUgY9KxKecKUC+Yri6eXzPZKh8XW7OUq/PZp6Wl2WnaTitlqB9onWhYjbDKrYZv40usYpPRTuVvigmk65shpOcvHVVdJypgHmdbT0xNjvFrHXaoGtdf6ApsYOUhrVesdM8SHRnvKKfz8a6bLVDNdQ0bo9ro2tlflnK1amyxrO6M5JTS050HaslRyKCzGSIyn3DV0GRwVa7iLGcwzei6FeSb4eAUKeavW1KSak/mr241pdqa81LbK6Plkynp8aJL8OGXznIuoPTYbgrLrpwrWDIfKqodWCpn7lnc63LnWa6oanJQqtYnS/ZPrpvZH8twG9BPntrRG9dqD6hrbE+nSdpS56JtGFYh0tlhqpQe2axTZPYQjC/S2WBVjJSQns6PHejzYQ0STdts06vN3WusUuomb6oW77Aep01sHqJqEqOisNHVSdSloxUbztYnnrHcpPXtK1hGIOOS6nDWFLKrHVBPqd4z2iDxbhj06BdPUyxPLg9UneJWUfFzlnNzWI9rtVgjI6VH2XGRpxCxV7AU4C4pam8dKh5rTKVYN+eSU+jnLrDmIY2rEaUpnobfra5YYzKWleNqGLJgEnWPnnEgVp/VDlgRj8qk7U9m1WusnJPtyg2r1ZewBU5wi5BcblUq1wcRKZJaoOtjbR+QWBpRo7LwH2fV3iZgs5Es7KJe5Krr8WAm0tTVF+FJkzYnSw8QmbGVDrbkEaUTHpdN5NFy5aJRrREZDV3uc6vtsGyWl9lRlKsb4pXwCFvOresN21boHJ+QM5kY5UvaFa/hU1KR7zS0UAo2i5m0lajrS6Bc3KmiUGzp0VhgIE7bMh1vU5u0ThlSs2pMDA/pkirQHG0MYRInnJUaU6+o7m6osJUnW5WSHdpTU2GzVrJp4PKszBvMksrasWMapmITnKpooh+e6SQhpuyx3QxmL97iqFFac6Kz4o3cE+pRpBBzq2hIzKeT55wW5KnmaBqxklbwmZzQLg7bds5SYJQa8iAV6GdvH94aWlB2UlmIrWTtD4dKsW2WI2VUWU3dc5tSI61SbqqpUCEna1zhqTaO3xVLTZSzVaeZbxTnoyWs3torz2+oDu4SUNl2SLEfUVcbXBGd1tqgmNpZIDMS61Io0F/jZePmUV/PXS0epl8V6hwzkqeqCRMrZjYgYZsa1+2OJFekD2sXa9EqNlxnGmfPzlyWnKG2D1/jqiETluukY6wf51clMeYZHauyD86NLN2PlxaXJs5jc5Fl6LBdziZmeNEeh1jpWFWduDnYaw4Ky1jhkvWhGlcLY9nuzi9kTyVh30zjWSSOHLJjj7TrUjBN3xFVVK6fFjUIS8tZUmPMkHHsy2Pf4KkwL1TNKkwQlZ4QH5plICnO8I/bTdUuE6NYbFEyK9OY1jLqJCfNlBPs3dwbsKCYLttwq2wZEZjgbeLQnVuwpaeW55lIJqiSGmOs5vIMpywcbLGK25KbZJyzXOvsLafoqVLf03EZzw4p3Cntm9DnlZRVUN1cjO2bJhOP2d1LX9Ylr06hE1qP8+yN4m7ycsou1SFRNg9VK6Ks7i7SLN0PGfJZ4V+sMc/U3zGkRlzJX3NjFeJz9GMQCuGdT7Vw68veHRGdnac2nNVvG6VX7AqlKqpbCNxXE63VZh4N7tvronIli1dml51WT2cLoReOrZ3Z1BiLpNXrsWeTZ1WNMdbtiJgJCuchrqbMrR3zIPKy5Fow12JqFNGOV6GnqHJ0KaoarZfVlPdpUnCuDi3VHukjrFgtLd4WW7DdFqWUz+qZ36Tvlu7bDOoliCquEWsSaN3jTp/e3KYioUyg21NU3OhJZ2jgIZKO7+qEnSnfkSapIRTUqN32EXKhZJIl1tpLJTQ1NSwKzRXcUbPRG3Ksjx+TX/b0F6ZaDuaREYds3dUs8R3qpZgYzFqUcZR3GOVfF9bvWRf0B6VnxbSTH0/vJ+qwGW9pTFLaHZadpYjqmk9wJs5VpGhf5BD2a2mroG3yY9+Zmu6pyacVW5axW7ByKLNSlNRwaktz7vXba3cfslqWV2NqJl0YceHZSbHSo9UQs26b2/Nikcyp5vCQK+VYcCnWrTWUDtde6qrOXg4W3svuimaJhxxXT1N5HOce5cydXu5P0a3m6xYsUt1P2qtgnVWiHHGUU2/PTapmjQ8zSO6ophMdIxStbpNKnO3izClRVhBMsK+JV8wuqRynKVMkrG+M0I9QK26VLfKlXGjJnxYaoeF08W7WnU1QEHBnZCPwIcqdq2OK0PCQnK/lTYoLoZPjl5NsYp515fEds88knqMjy5IsqAup4M9b0axUabTjmy1P0abl75Mcrhdck8rZYe4KrbCUGTDgMHIx4PXX3A0ySmocb+cVmBURUV0VNBpPntRub7XfYls2blwc0xSkaLGKpSVksGDdMyKslpISW5aSGGfNMlOiK6Sc06wNkmWv7Z0wz+qy1MqhaJTopFSmn1cTMiK1ro9ZFCwXbB0sYkpuJTPUY7ESLoxg95Ru7DGs6SfiZmEjjtddIqWVKyYVVE4zHKaQ1yeWV5mRlahwk2XVXAwbNI0XcNR3MZtptAvPyedKszbPlGeaKmQuKStwIR9nUGkSSVaLLqQRJGEOEk8waE5pEKcOUWlN6/afVZveSp6rX+8tnSRccaWv02wss2lXDXInFenQKqOmHPIiFZBgsdzk5hdlJyEP62nSsBkpFtlSdLHU3JvRW3De0RGsDB4QUicdDqKY3IwUMagzXiaXZQ7L4xLfFVqiiGfnJRYjFZgcrIqt3Kuml1FqJeuUqCqqK26lENRvt3LxStbadRgOXPOipIutWZeiMGfuEGQR2pvoV/Htnp2Nj6O0auXjzB+e7Ztf0uifGSVMijHkoOwWpheubmzrrcowM8/N3GDnoeN1NIxhriboXsgt4RHu0Eug0pVn3q0nsylOm9Fv6GPLMK+S1SQzLA4mG9fYHqzTYqLYEKYq540Y2ktfNejnmRrukw7MmNgenE5gk/DRD5XQcE3Wq52lnOQNGvRe5zKU5UdzWSZg1xjNipmeDvPI625OVS/oZVux3hdbHlPf2edgDMtmTdZrFRNkKJeS2tTPkBfN1q1I5WVucF2dplxNV1voidloGhtWizOk2VxNqWNyECoXJGJo1KQc5O6HHfKW2ZqbDpwQU9Nwy+hoFyQi6JaedO9m2OFlmSbpEFEm6tbrmSWTHCmvsrTdBtiwGF+M6W0yUdEPIHTVky0u5uov68uSjCok8RZwHyjcWuoVYGcs2yyR2w/ODnbOFswOXA4S69jaimNuznDiEJGtHfq2c4yzLtVeHWITkCwhjNv1YqIZjTExa85QW+Oz1dKhzKCVJ5RUb7QSERW3nU2bUFvuTpcSeLHT0eLvcxyu7hpSNQya9xP1tszU52CwphVKpuzdFyae8SZYa3bMt1SoEZgbVeAO0zEUGux063CgFizOEhnuaIhsU6KqFZYlzqch22kTsqdQZZ6by6Ec4tSWoGQrk9MT9TPkDRBsalAqm2QgExAX1FCnGlct3Rw1ZOhp1V/pHBhOouA2tBXjCK3un2eRME2o8JWe56Yoi3MboaxwI7nacyXOzfXflAtiq1ll6ZuX5Wvgzc3yDCUgZ91vD85t3RrQko1n9iuhEQ3ia9numM1r2tkbL5Rr6DTcHNh3WIjSsjCJ33NkZtcuSl8ZLyBXp1DhVzGfkVNy3qKbp5/NpUmgYS5cUnlgzxU1imtmmYbj52HXX53JWyrno6njaLMrlCsjpd5Tk/AfbB1QZhH31h5rC4ry49nbaItRFaXu4R9M8ourYuGU3C0Ky1qy6qAa26QqslgNSuzRmSAw7G4dcNLrH5CsLs5ukNgjKisqLsdbVBhUakxwkl1WFuyl9l1KCyrM8aAUEE7qXBqyXPKmn5LomXDirCZqTpvV8tIhDEqfrty0pdHK0V9e74oUs49xZVslj6OlWbB16/aWX7Xsm97nthpOLvRsE6jwWpDy4RbfVF6d5Z10kJ7lLXJIl6dPXy6O5+GP3E7k2jGN69ybdN7w5RptGNwlG+pdHw2eDJAy02+WYSZSH9kaoszVG6hdHEwQD/Lyj1PfDLbOJhKdavWP9+wf0pQVFfKfo3H0HSVlMnIpqZ/SkvJfzQbbbu4s65oeHBox5KbXbeblI96uCidjmo5abvJU8MvTTXSOIzNN2FLJbqvoYK8mGa8WcovuKTTgbyHt2nbUNRzX7SHLGJ4TDm8dt2EPJZaxs2+zIovhn+mlsVmg0ykObhKelZJikIwl4SSenN5fEgrncSDT8pQsy+FWnNHt6BpkrMzWCo7eE22bWG1P0ej5I6Ya8XW086R1rczjSuGOXzHcDU5VWmAk6+VeMCeS11yPcvehTqha1BGsW5+hsh7cW2Vtsl9lVcosn2FV7pszUWqQMDBo7evlrpciBaTg0c8oFyswqBcemzGr5Sh4adigFqQqOmpZ4SYvq1GkZmSjKmdYsWflsmdrmiWfbfDKMWEWpbEwM8pj5WqxWBlUSejnziwKT7feLagLml6y62V20ypgD4qXX61lL+1aK1LMsdrh8xBk9DMnFWhenJ5YKFqzV0/jjCMXb1EhnA4el6RSzadSZDamImKcaeSYbZ4MZFRmmFtp3yoX41VpGMxeYh6Za9YuTSoxUNzSGnGSYRwvNFpTLo51GrXV4d3bJPJYyKOvssijYpsR0V3WMR3Mh22XLF4jUmSNjeyZ06xgjeAzThlbJSSbKV5kzicZTevT0dMvKQ+1lonWszjd7gzqNahcNPDljORgWLgQlM/R8tmlDSVnV1FeLdUoyvPaE3Dh5s4kMeWtFmkQX5Vmz9og17Vfc19LS6/wHWnJWVRs1DGe2KWwSNSwsYhhS1Ij5OthS2CtJSJZUiMkX23Py59MUZZckeEI4ivgU5LVsCsfkdSOlpJbIiKmky6ll8daI91rIMar35I3TRAxXddM4aYfcl9xlFOabXHr8ZzS7iRQFnJqqyLiHdUK751fKCpqqJVnkThUzI3a2A+p0ycXVAuW29L2FzaWTSZycavdnjSSJR3ka+aeUh3vrg65HwumKxzu1iThXyMf0FzlVyKoG5DnU094EePrFDBUsspmke6t8Z+dtFLKJZftXWwcn9lMjq/Y5tTOpJCiINpfay+WNM7dcuCy2BAVbiGaZ45zHtwRVxhwGmaPWBvNH6iaTNNvmNlksfFW1SNlUq7QYvHlJGysIlyNa0xv4NvHpVWwGwtNbLSKousNDc7f5I0Sym6kqKVXSlZNbWOvn+4emqZpWsxvJyoy5xMMVJYvTicTbx8ypS1z3lJI4iSPKdotLh2P4plfG6Isc7ESWRB3IdQc4Nvr3rGhEphpTpGR7GAY3jYXoWafHyRvJU3v6Gse5q9j7NsTIWdjXbWpJ1wgEBJU3CpvHQ2vnK8g8t3qb6SmVxcqp64fV5ym22ji3ecPknAKbZJPEw9xNwxQbK6lGxQk0vcYjTGbMhGvamrcWlHU160bFRsrqxgtVJTOZtfk5RddC9kumFhxzE0yKdISLi2bW+zgLyTeth5sLyjfJd1Xr+oXYwmfKwszChzkc5dhrE71YONcmySlpq3X880rIG/wn57aEnNXCG6yqqeOW8jfKFGpV+eF2ZUlce/pnJDoHKLqYqZqKVEeJkveMSMLMdIPq2ZaJlSD26drrdCg7HEZ59UYi6nkWDZbV/CXH3Ra1fbsIBic6BpWXqHVkOtMCbAboTbZMXdoU2xZpZnYuCbij6mvqVafYBPj17EO76RLEtrdd1Ax1eRMng4di4ye0qpsLU2lh6UrNE9w5FeLlCWl2B2sk/e2Xs0nlabZq5thjmqOT8koHkvVCTORkmob0UzxtNnkybCkX9Kco8rOyqtj3ShsJ80pZakcJc/cj42y48eR2MtcEVIhE+fuJWFlTGKZnmfdSOOzX1nlLV3VTpvMaluccUpkEk0wW5yh3uuPEeUl3mOpsDLhD+Bpq/MXFxwhVE6rXGuvkI7wX19jUutLadFo4FzvzBIloBSK2RPMp0zmixOUahWfow3ab1sUzPUMIN+wKx2KnBgNlmkOK1PPKdwN8p7oMWAflCXfVitTESzXaSrU4l5sElLwjlIV26EiZ1Ccrwfn9Frrlq6gXC4LIafO0+tQXqMfVUpNWlmtCyw1zueXNtWTDXBa3p2ZGlTrjnFgNRLhG9lR2aieY9zn6uLWqyDRGtyeFyCe03bllQytHqWojWRwDk/j0GydL98PWV7X642jo5SZbxgWLBJLMxprZB/lb0ck6dFTKJcU46RskRwR8dRwqwpKZ4iVqm/jKeznCu0WoKyM80uOqM7ajNZoZc+m0wn23OJgW0+H5CQhLJ2h78WdYm6t5teijucgMecTUBWpjONulRVSVM3jeeVhn17wTOWaYyXerlbbWM0STRdNzxAK3TIM7yZjDyjaXxcoWBab4ylV2NbnpiJyqyyTY/ddX93ddm6aNMweJJKrHpKj4idgV+kNpGDy7xu3V0xWzFNdG4v2FJjvlRlgtqhpGLXe4IurtM1Q6hggC+TQmOAf1bSp65izieOeCuzVG1oWXu1Na1Rc3pnhpdRejKwm2ysdb/HMryywYaumD1kfqcgi0eXsztxOm9l1UHHtJtsqMzFs588Kp+NxWJXszG3RcSOJmm9KtlRSN06bTp+TYiKalu6gllCWjDIncE/nXXbWlWnODK6TbVkqjS7q5RejD7HtZuAL73XtWlVWGhJp4iKpC44iJmntUTCQoKmeIWubac4N3ZkgmNqinzUdpWWpIV+fziHztCMg0tQUqTHul55j5xPo21gkyo3c8PAtLwUh43FZjNvY8TIcVl2inzBV1qNZHmSOSc5ylmEsTBVZsK5NaBSXaRBlkZryX+joYxmdaidpTKbmqicVodfc6VeiUYpKoEwq3uRk5WOfa90xKZsOj86NHK50K4ct6EZdh6krEZDuZ2SyEWgR6UywlU0k0ZG1r5DY0iDc7e7RIZLIsZQS2jO3l8+wtOZdbtzN5lmO8ArZYCCpU1oqkaporeGkEFKtG6JH5uopMG6MFybwiS+HLstrLChZaM/VeiJaUPOjEBu00LTlWlPhXmpclXP0i+MnJ+pa7BePD101oVwjE1+bEJLpmqy4FGJwkxlWGs+WnFwp29Xl6Y8rEOOfW6zkn2/aYg4Hc8nWV4sMF5YUcC2yFexic5cTLvBgCfQUzM83YuSOUzOoIG9JUfSnr+SWoW4PZOqT8XSO4SCetLIO2HNOamAmVsxRsGcu4V0b109xU2qldCBa1w0e1OGlImhmZPP2UaH2ZzSSIGdn9Nhez4opFbDm3aCKq+1Nt86aqgtbKinj3l9MYJ4i8Y+t2bDtIpLmUNYgcN/eNN2f5Wwf6pTjG3hWJ2ZSnK5v+SX3lE/jIdUi0hWHoCNjs2pnltvXDRKXqKfj8UxcDPJo6BeuV+3LT61OtyiboNPguRZ0HRZWlNKkjylNp1ax1J2szzKpGmewBs8rbk7RFpWrIRhaahEecXVom2tb0t4obR8h4PCK4C0rLxJysHAdlxEtixU3ESFNYmlxLqL10tHfK56ooBCXHFupHaacDuhmESmmTSAd80ww3wuZGOfHr2rUoikjnmzraHCKGSXVVG5trGnQnS7gzCsEk+Px2A7vF6/krezunxeqZKJtTOgcmxtW83Vlmt4s8M8ZoNAeXp7isPGj4S+t8Z1OXSJ3VJ4lKVNcK1rWFzWcjvEX7guTGHaLGu2mHOBl5CbzZBmSmeUtUNckZVli2BtxMWlmr6ocaBAQrs1ppq6fLeIPkqSa028bT/Da3nOYmdJhbBWhX6IPIzCpUehSJScj56aM2S0SDykRLVYdc2aYrdwumo7bNozRWcz0piLfb93Xip+gY9aKU6qpTdkQkVzoZsls261iH/NP6jYcr5bSC48xX+9sTMzT6G25DU9g6ewXFWFzWW7hjqNt88+bEq4RH5jRDaiqIxSXJWtqF2oPluTbb9Ghr5kPqrSGsaWvGy2a1hBxHNVq5s/gTe2kmKpQzNalLXKRJgjfy6jlINNrLG+fSyfRqVCd3JevlRVhT6AaK2bik5T6bp+WVrPlcM6jUJ7rZSwNFt3YWrX6ERTz7htOJiSi6MsyXCKZ7RbLYZVybhNdnroPseFMrubNnfTWrluu8d4bYM9JUp8Yx3GLCPDdp610dE4KL53mJ0sVZVovTqVvYgwwWeIb0RnqqaJZTUua4K9gKLAiU3U1ocxth2clnVTK5mjslaRtSvRTNNop1BYsXzALp0qW8BktD+u1o5YaLlcwkjJN5pNc3PJrbxroaoYu5e9GsI6wHV6n2GTkDmc1YRxeIeicZcit2I6lrTKOxiyTIRMfjFkzE83NsF2XDzAdjtBhs5FscNoHq6FS95dSUqAp7zEd0zRQs9YVLudflCigTAnlL47gyV5p5Noa9lZVIJPXD1MUIrTYj+bgGk2wUoyoDzKk4WdRoefwDWBl0vIey93ZVZbbkCeak2BULtyq64omtGCg4B7mlrgVERqS7eEx2JucCskWVGtc3g9iLBrq+HndpQ8bjUvS7Kqe3KlOjl6yqhoRaTBe223NsY5yGZqJyiK0Ws4kapfoJRnwG25g7hqcIGnY70oc5engcR0R7apQqh8sY6mQZimLTk6pHd1W6lCfF5kijFCd51vWph7Y7NuTUekraFKmZBveotppGqQONVnZXlGvG8mxc6taV2oqjBtl3OeO9qGkoTN2TBjUDmAfH6/vHZ+y4owOYl3c6lYSk/Eb8nGNZymunxaqn+1bsQ3tzqNVIivyFzRfrXHIR+tILibVJCsoZSmQVpxrG9oQ31TaKe4RHFDYlJ6pZdumaO3wGswu2p/qEuAyb+Iei2Zuxelv5pMKX+Wu2OTnk83cKGQuriYK510TItzsY45ObVS3Iw0PZgeg52YLMpto31jRyFEe4I3l7RqfbRamsVCz73IsIw7vqeIhjjIN3mfV1tQUL9OaY9xLG2BSYAVKHLDrKqoJ47CRJnIjc3USmFuaYivY1DAWbprY9m2nEO4r87WTk3LhWR5soxrl0WqqLlwUnJeU8Q/U82cZ2mId2g4cc5mWshGNYNEyWwyqmO8yYiowKheIZx9LkdU6r2PrFdq2MKlTpAyykmYGl+sh4+MWVGMnVOpUi5DaMLFQ9KFkrOHgsBXzTzHhX3BM0jRomQ1aoGAPpWrdZB6mJ+BioayktuOZT+xvrpBiInbqKqsbts5y5Z2ylqKXKxFmaDSzHAybMy7zZt+eIuNYxq5jaCSp31zoXJTK4RATIpsq5ozZ69tkKp3rm3ImiGJr7K4kzQ80nhcPsBOw5B0r8ykksK3rZBztnaueFNViKWdtY9YatSeQ3J5HmbGH2BwgkOwWYfFTZiC2C5LRE9ieVVd4cCzx7krg1HdXU0srlK+fcBAQZ1ElXPQXne7PGWzNKrhbUxCN1qCX65BaxqUm3uNYItFesXHzGREvWxNcUxPcGKZJXONjKp8r4xpgYKBMkOsPL0omkrZU9ikc6BjLla/KjORsi2TtsomrK+8uUdhWZ6iqJqsLn8teIxpu6wyomLLv0U2anY2qI1+v4ownFvCoktx1cSHz2hQt7HES4h8MmAvvagXwqw80MGVN7pZMUhgQn/HWTaHapeZZIuQSIknl5B4h3RH20nTR9OIymV/JJtovzAeJK1MkDBoRSGPL07Mg31ROK4oNHlrUbc6aaJlnZU2z9lSMbl7sjA7brHCt2Yr0UBWnGAoeE7Kn2Kmi4uHbSu7P4Olb5tnmjSYqC1kuC5EhFjOicCadodRhUbK4nWjT7CMTTCphILKi0tVQn/JTMLk0l17h0apXLawSERp5j88PdTD0+NfkKOPRkCrryYtSqeJxVKGZXw81ylrqsOaV9ZCdjUqwr1fknlFeX+/suM5TjmUSHJ2tm+txa3BMIuxuMM/px+vd66znKimTLiceGA5tjiM1KKLLJK3eb+3rb0kYGpRxkV6QreAVBhWV7mHPE48cWfVU2SqKqQhc37XQp5XKbK5TT+n5UFwa3s4OYCCTmU+kIlTJbBSicCTw61FbraUf0JTzcvLmbhkgD1/OTRBkI01ReC2SDCnVX6lyXiUxVVWQqFqpsrNK46WL6O6jI5EjVQ3orArsMNHUrpwV6BjgTg2aoRkV3VqVYWdwnibUFGauo8oniIrupeBRbRSNMM7hVFXm5pJoLKucKCbY4V/tY96WI+KPqOLOIxwfE862FB9Pqbbx8NJVlXLj4ZGlzm3QHVmqEtSR5yFm5/VYjO4P2KBhWM9NHOfsbrLsWGDbaMhgdKrXFW1T6NfdYMzloVwiDNJno5IrphbWkN1qbM5sT6RNpnDPq6FynmryGdXu7aFepDPraKGnkdSay5rxH10x43B4JbcQD+SM8BzS5rSO9pPM67TzZhfa6yjSNR8rot1b2pneaxQct9uQVljg4yqr1SaY76RJo6evyycQkoqabxEGqp1fEpPdDt0M3S6XKG4hogtlHeiVopEoJTRiXMxQhy5umNnRje/b9bPkCrDUbtItGzZQpmOXUbENMi3RT7FZl6HZT5Uz28xpiehY4poeJ+4Kk+4RDd9SDubN0WW1o52ooVrRJYsiYQ8NahycJ5mR3V9KarIgHCwrWIzmya/OjtjXH2uI4uKLWVKjDuARHmMOHrAtmPRMrcuRaZZjLuebZm7rVV6pLaHcqVumVgmZWeRxYVnb3Zir32LpdBHwk+dWD1Sx52wjItNdDO4aKJ9azOPiKGLP11pqE8+n66nxEqqY04xjHJGzbA/UGSdO6FSQ41DToZBP3apMXGXjTfARXaToFaklTHEpjJyJqE6yM5rwISNYo1uob+tg6crGG6AZ7aPRbLCd4fFE3Ost7RXOomJb7tHs55Osxt3LkivuGjHTYQgym5K2k0vQGKyRaDFmzLeXUw2MzBKKc6XRoe0cD9HaFTcllY7hHssYp9IMatBMV3TuHxzRVhS0J92ko9wpnR7UC1BYdluy8NqUMCzWSS2ulJjiZCgqMNX1X+B5D44jDZ3kaeOXMVKVZSfmV5/oS/FsYpghqZrLXBwNZaaWlwxN7ZtV5CedGtKiIJyLpiLNCqhtEQdm2JNmHFEe5szrcOQeo5lxZJsvEC3ulLJNzprj9HXYLWDpIlNsLqDdmijvMirwIBKYlA0TpqxNairiMdcbCypwiiLfN1jMD+1X1nLjZmSSDSLbGiXKpg3MzZAxWVCi8KhMoTFdYuAfC+lfLa3TcwmY4mnNcFHe9aVrjicrL7XjUpvyzVIXULdS1FQfXZ4MpR5yUMvhSSbt6xFHipKXFYsfYprQ7IfzGOok8U5q4Gbt2SAMp6Vsmqle7k5OnIhc2KtvqaFzjzcZm4+czx/jMRoK2RHjcxEQ42sqFJwmotjnaVvhoWBeXukcb2EVZXGe3GRPoQ8aoFmyIahv6EXoyynnWpWv8mwV8B2iXuHp2g2wm5hWVVkPdRVnoOAo1nIo6nQJY9fTL68vINHgM6KiLzSqCagL4m/eIuKZFihdkiLjzlyTazOqaE+srNiTL6UimegnkPEv41MvYvFqVQ+VFzIah68rpu8iUZQdIKajbZmq6GJLL5cysM9ZTB611ODfNRadciaspPEZpXU08KgsdPBjjpyk6yxbUGMb8w+TIvIZH29O3wrwXVpz1BdxM2ivE2siNGTTraeeahrOkmsy8OdaGvCwB6TNXyXqMd0QyuhxUZIxrRPjqpXy2KYKDTJp63Jb3O0VJ223DRVqUVodqA0wnlCc0BYO0FiiD1cfms0x8WkbVEft8A+prPBa19edttiUC+DumAtRX1qg2NnOKZiWKSaxp+Dg2eAn2KYxorNiMpcx2l6mb6SN0F+sEc5TWneNGVOg1I2c7tgbLLRoDrGtNVVPnWiXldNclZpopHLJ4BVrLFtiG12sX6Gs8pekkUxLZN6Y6yHLqptlFzNj1xFhnJJZtGQP0WUzK7HbrvDKtIwWGFJj2mfwGWhc6dQu51ynisnra+xh62KmkyS0KNJRECsnIpJloyzMbyCW4srabCdXKlHaoCR3s4kqUo4a8NYtahCsNwzJFdlTp+6sVlPTpq5TttMm0BBj2jb3awzTrFlWcS8UW5edV2ipb2dk7qhRU2xXEJlfUFGZ8KllMlKY5e1U+G44aJ3wFhSVpaWn7Jd07E0NXq2Q37HNnKLMW8p05+FUmuaxZJYV25HylarfkN0L11BtFdnq4snN0mJjZ51eKevbc1+drJ3ozDJtj6fapaYalRoQs09cotNRG54TUucekfCQMNcw14yynh3nSDHNHLIqzJkT7UxMXWnUE2UYIScrMs0RJm0dsnXZes8ZGOvRsCXzCt7KCxKtYBYrYElxCjcN0lU5nRKdzSxfiUzQ50yUZi1S7GL1XZGKbUbIjOTn4x7RaJCJZQ/eY5Nf3LNlovMwzWVTqM/ytSvh0uhaNCSf6bLnkSswtpwuWq5eZBaMy6rrzYmy3qzRCd5jGc9mZyZt15uhYNrkZCqkT2kfIEgp3lay1dehWIlbVO8nz94iIqhWhC4M360kr2pN8TizNJN4l9rlMJduEfXcHBsWtLGubt0OpmfXc6cULeou1tkTJhPxl+rKyi2lD6cm13Fv6mFT7YxUoZxJmx5XMN/u55qOVbXjKA8rkS9GzmbiZYwppeWuI0/eX1/WSuFOq2vIIKewVNmmmBFs5FBkZqzqS1radLAIpOrhMrOuoiiUE9pn0oymTCVlGQtdbS2t0pwVI1C2qJgoZGwhNBIXpjEM0QvlTBRod1+cXs/lm00kGhGd5xN1ZE/J0yrGb1Bt2TVzlC3akFIwslcT5ikbyejgGmLy7IzMJPGOCiTPY9UyXLUaqQt0ih9qMCXI4ZzUDpQyFq6f8eLRYxmnZCa5rlhOtFpormblJ/ArnKryX80qYA7SiudXbWiSjGSQZS/pXcwko2pujyqRld8Usi1KKqJI3HNxc2rNV9hPqe+coZlv6zIc8tcr60po0yLsDikozFYgJPbgEVLz1+lmLhreNlgZTlUiYOUyLNyaFtjI8u+Q4awXkBTfrQ/lX7LVblll4WogVrAVIR3LHBmnJaFwY25cHaUUrNNZbnKxjBimIFvXCFZxaBh30I2hn6psSB7tpWlU3arPr1et18recnbOzssmWW7qXWWvY9jkKU3Z2SS14euaYm9hncuytCfjXeXZpZ6mT1yjo5kW0RwLCowb3jIN8+doJiwdC2DjtOspXd+cUlwRo9DpKjcnsFdiTpdRKZGM1ORyZFcVDS7imcyMT5liCCcwnexmWaMl4mLnoKW0Zy8a4uqjWmLl7qfPr6odG6vurC0jj5AbUrMgkmPcMKrzcBuOJJAvIaitIWcVrmkdHFkpoO1WVpIfp+wQ7xhgWmBj2JviNpIpDw9N8qyYGBIZ7xGY3nKzmFUeHIitG7YekKjQEhXpoKegDWIxzxuM0i1yk/Qi3eR7eVEbdldlrWA0ShhpIG4mTfWSSzEXbQiPbNfv060wV1KeMNvmbKVlbxadVl4iJGKtpU0mq6kxTxtjIStRmbQ1EJbqYtGTa3In5fLiFk5QsOcrpFyNcl6I5jVYFh8gFRsU0NJfKkyXdu8jzpCskVmlER5TcNVPjiPy3ZOLcrRjZ6Qt05wyc7WxmSmcX2WpGTIWVc5on2NTEaIbEwsbp6cYoEceju6qrIiSUtEOmuVxW8spI6SPEB6Wj07r6A7qnAvkW1+mGWxgVLCU8I/gUeUkUvlaUVnXWPUhJ3QV4uZSUusTLqkM6RNPZvKh9ZTYdAszblVYqthLqakv3aAMM+aj22yRtCKPyi/pzZQVMJDyVqTvWpZaafLpDmVQIzDimiEvYwkIsXOhZwzhsFiem2Ovz+OoYEpOyWroYNRRZ7Dabq1hr4pm8NsjWZTwzOFRamtcECsimM9frBaQUW5SkeOQkvBSTw7eDdUsjy/ZZ+zi4mKz42JNq9ybqkimcuWiY1Ffbo2mDBSmmZ+a3NoNTKLga1oSSRbdE6vNnhWPj9FvcHMoVOUJHytt2lFqLq+T4A3rsCGeaJ/TKu+XHWivLqqiUdKQ73ep4Q1pEdlhXdJhGDTa688nGCz14Vrtl+mgEzSfFrF00WuYWV4SUK/k5m/jx+Am7hMTizMu6+TRdUxiapWQWW/g2eubkWGxtGSokHHP3qYdyKRU2oqlCxDbXRAWbuyOJ1CykJTcFKaS1dNgn+IU7Q2rTFgSG12KcgqV2G7p4fPZrggX3GPYFPDvngzMCaMiTvEdGRIvlNfgG+lqpJg1bo/cmlZZ07kaZakL0Q3wrxsssNca7t0Oot0jqR405Y3djxwQYSUeaydYRUktLMiaTKpzl+mXn+WthxscGM4ZYCSk1prqtRegNltbHJep1+BQ262tYJhQZiwVYoJtby9wEfHj12QYIlRiWAw2Jt64EGvZ1JQV3s7m36TILHDXK05wW2pcKecbZpLfDtchFBKasW9nyUoyi9aXTBRSnI6lHN6N1K8Voe9bspnicuVMKsv0kRAXU6MPW9xtMIzpHd7k5uwcFxxQT7bWDWKe9CDLmg+u4KSe5h1UiI9iJOizE6k0qgmwLCkqWCONJM7eb9XMzSEcoBx0ss8r1WgaWd3WUekVFCFlcnNTjMsZclsanXTaZqH1LF6ebOsxJRNaEhOw399zJ2Ip0WwTzdwLbQjwpWxq56hJ5SWYraorF1Gg5a5OJxXKHzHsTamxzlrI7XF5EJArp/Zc3t3maozPJNAWV1cnDQw0lGLMdd6WeOCmVtJ0lJsd6HMwSO5mGeedFfEKcbKdUi5LM2zjFtyJ7DWfEVXqFfQrDKfW351pHMzoz5AdUwgUCexrjaYNh3JuSltUaCPUrmQlcyFscpveGaAo8F4t54wM1jY31vFQWJrSG5/imGL24xdjD4tMaW+ZqBrJDOJpWyIjVpgJzA1wpmOv4Bkj2ZxUXmK15R9PDyxxDvWMk59nkmNqqF2pm3OcWQzMZyHoqQl0FRFam1aOsxPNoNxwEF4bkpQb4NCULt9wcmCsK1AW4Ordc1qvch9pGWgsNKZW1ZSto3QLWN1vtOMrGdlX1qnTLizwUywflOKi2B8HyugmzKYn5d4om+6NWAzq8nho6lDgc5cULG9XnNyYEjNsqtBxD06PUi8bLl7rTRWVy/Jr1LYrdGPYUWhm8zOvZUrlaF4Trye2UC+LaqsiFPYjKVN15NkMsqLZY8wYrk/aF6cNUs2aE++Vlw0i43ZsUwzQ6QgstRKuM06j2SaUXxKUsJHQbBXNNx9QWy+m5N+h4R7RkSkwWCfa3uzMOHTX4GGhkCzvqB9I7twLIJkn49ZODSrT5g0QrjFIjpkNzZAki6BTJIyv5SRKsnAh5aAha+VfSxrrEd7ZXO2wZSYrGc1pnc8UJlDq2KwfDlUd0CSUXPolVeLajeUaLKkT5aEp1jHOdB3u3J0ddmyVJ2CiWFPQkhWvjV5SJJol42DwUhlSro3fa2Zckuqxq1JKNi2YHS1esK6l4txhHmWbTdHajS5rKIUfpI1zb+fQ2xgjrSTnpjKgW6HXHenwo89MMNJf2w1PjhWvlNNWbNF28xxmlS2RJFYquZfdl2HvLFImWRZtXiaiJiwo7xqqHC7HcZ9nH9awbq0b4Wae0R7QECBl5dTtdyDm4J0OEY1JaTEnVGBsn6ngipo2WBRoNlUT03TQ13QSp3DZXm5dHVvjlmQrDakSrVpTF6NOloyS3jJco0/NdpS0nOCmGjiXTlKpmy5VzWwK59ATcOHrH+YVzyUummJ1SbYQXFPTKKjkHd2aL5MxFhUdrNXNlijJpTBqlNyikkwrkfMYVqjzrM5cEXUtH1EsdPKRTPNW5cuZXF+UUBIw5W7dkRiUFw4MXc+rVucf0lkQeLYVbDIn5eGtpgZYIadpLZxxdvc3LkqWlll2Fi+ZpmjvMA0R9nEazxBkqVVZqxObkS9syZCo154kGkrk6uQtJ50hqyWcrmNdX7fMplHf8aZzKVqtJTBrKlVoMGzckYuysI5tzZuoEHJkDN2wcy/MJ1nOEfHeT5GjqiTezNqL3XONcxjtG7T0Y8pkjY9O4bVRc8zmY9hP0XOoCaAOrJHZUZNSVs1ZoF2vkCUvtV7zmiGkkF3pzWAcItXa05dRUTHuc1AmVwkZ7pMi1y/SFtIzoVVi1Gulq+PMXO/aHWLNYc3qCmmXUySjHKNhL6pym67lr9koomXgChOpZ+HjYyzQsBLPKxMR1HVaIC6YmKakaDZQ6HRksqFOzeBT3/BIZzTUdtlYWXOnIbKRcUremRTXVzBVLFptZF4SnuhK6CmrkMRpZpZQZ94VKqMlFVdXkiPTUuLNGHPyYi1o5Wzsh1MnbGqqnc2rc9kUWybdHRWx3E1gHFqdFnFvFKATNBRXLqUp8CUv2s3gZx+rT/euYg6mjpmW4vHP27LoHKbp7tKlXmoYVBDtcWGszaIgm6CjYyumndkYYXKjVFgpk5vuTBtWm+8p4KxTMHFPrO1OVLZasiKXD7NvDSQMtSZZqiFM8FKWzhs4lXGMJDA1np6w0I1n31WlS3GN4U2iqotjJ19cC6YdTWCb7VHSTNpGlyZosV5tKw/lnHTmUlbQJk1tbC8N6ukScmGPc9swMx4Rbl4ab28l7e9maamUpbEirlcn3RmjENiLWKrQ15Cp69wfWOUPkumHK6jVnhDRaBcPHlaupNdvo9yI6QruyivsKXYaGiIz4+HSpnReaKpuGS2q1mZonSYeqtwRZc8W3JGjDqtOMDFvHFVf1hGlLlEjmxzmUBId7WNfKrdNrlSdS1hRkIolTApnkHPrnqkSUBonc+YuJlyOSxLgbGZZM5NYWFurFnSSEuQPpdmgmTHhCqWSDrATkMYb5hOnLpOJJaieTh+m7BgNbugZNF/MGGnXm1XY4xiltPNW3ysTYM4y0fIoZgxQm/C7Y9XTEBcnUiT2MpbR8zTjkybU4l6xEJkaL5gqrO7pF1cojqdY8eKqEG6MTFprTJnKpnM332tfm2112iXtElTnbfPoh5cenCujKm+Ga6PXohLjMKoLHFpmbXCXa7E0pXqWkObX4h2rs+VSExgQC6UeaNBILq4xyJOrmk/lKaNNEvRR4o1lIxNfTFnSGOUz15tVFzawHG+bGHETiG5Y6mQcOHGgWCyl7Ote5ayoiyTKsOupn8waW5lMpZhpYOvPViwiV1qrr+5NphCk7m5wNJi4FtpR4amPjWzullOVEMp2DeuyqXFPFG+vzGzYCh/zGpGiWm3VqTGwJpxMzllpmVzXp5BoTJZuZ1RoHVjryp8uYRviMUpXnG6PFhSTVFywISBP0ROeK8+T9O1SIDJiGhck8hoRi5BZWLTmXZOzE3Eu8BeZU1fNX+wxLArRnq0Zpm9t0qVl4qwlWeCtHTPgLhTa1Knkb6EwUigj0DAiaBdvphhfVVDfHZFpHTBor7N05PERTDKSzfOwsrKvjt3eNzhz0hWPElENtx4vMeyl7cowsEyaHY/epTFbseCsT6HZnTVNLY+xEueQX9SMTx6jzrFqKS1N0+RM8rUbUGD1YukRqBJppSvtKUpj7e0tqG5OEdBsINIeZOBW4rKVcRpM3RFszYZi74jt2xsqW7HNylHbpp94q+WymyCkMdoQzQ2MGjHRzKjs2ujVbVEUZlSvUhjKUycy74vWHu2IY9ys52Mf4mBv1GdQ05BzrBum2R5qmdijrZdlmliaJucO55spD9XUnnRj4+ujTGhIsxnlrRnXo48zmA4yFukZDO7OK3Dxmubs5eYSb7CIsgjMuDTSNPJmFYqt2HbR16FnZmLN9eDrK/SfzMyL7e0kHd4uLM6r1JGN5HNUCtfv1qLO6E/hW6IsSQpdUnRtDtOh4Z6ds5CXMmOt8k/oGs2YJN5cn89RW2PQ2eEcarUYzOUrZl3fNOnonBgwNCimJBigoW1q0zLolNRbyBUvTaYw8lRwXpWY4m/azAvkHiUtpfEhSc8a49MF0ZWhDxLi99cScnBSnmmKraRVqctOa2n3EVJWn1ZJJqgM1+yola238xEOnpuWXFoO67SQYVUVZyJMtd9TzOzmEtPmIPBgHuGgC1jyDLNri5ANJFUVZI0IFsXPrdqI1MZTbTDNaW2U6ehoI+MZlBPblOqmn6/ZpJ2rCXBOzZbOtGgnzDNasa0X2EfabSSpaCupKeVla5yKEa7UUxGmHGobIDcsV9Bt32XqrlgjsyQtD2FWpF5pClod0GRuFOJm5i0qhKyR4dkW4A1pD+qTmQzsKJTustyecuWboOKbz1qiLKPUaB+s6++o4uyeIKre1a4ZUJYuYa1gFKuk86fe6Rlfy2jQXHHh5ldprEjkJ+gk9Badyahe55JfYiyyMC3eTe1erU/j0ucW2M+Sp+szrWRVzLRzG1WoLNuoMGelkhxaYWWQ7JqrEqNbLHBKnE8dmRJToN5g8RBYGFg2qp0PFmfNmJNqjzBdMNaTMZ1K3guUKOXkGNOoqGrkF1Gnnh7VddSRZZkTMIyjm1QTXIxY2lQUGdxO12JHoAnSHTNOEpUwzpitMAxiJqArER1VJhzgzupJyYojby/cK86ujg/V2plZarQkzydnIFprSmpg3xtZW3PX2eBNFWFmb8vrE1YpVhBt1VYrbGfOoJwccNAr6yNRpGkVrI8nYjcUaFrfVJPu3G1eWWG0W40i1Bgs0ybrDR4dLNtWSDTLkWWy54vX8RnkMumyoh5Pah6kXxzjjJBI8FJyJhjNly7Lp6/vMxXzT9Fespch0mEPTxjsKssbHGVaIK3UGWrw6q2XapgfkWeXqyXtqBUhUV2rVxpWFR3RCGFu1JMmiejt3yje2TXtJJEpEXJioebd0m+O6wYr2wvwVBEiHdL4HiWH7EVoIa1oKCcwKueT8uKvKngLdSjl1WLbrUxhWBFsV9OoDGyqsGbmTS2lFrA0jdVu6yVq3HPkTaOj2kgUWeHM2SAmXOlLbXJYrO+nlQbgGlzVUW5m7RTq3RMSkI32WGQNjtgk5pKRZaHinyCSN6gS1qipSKZdZZBfjSwnqNXhl3RSUSfhr5ScBYhX8SGZmrXvyc7i3kwrTNbmtdjSXYbi2aHK1GJbkNAWMt/JjE0Z9xEPU5jqDtQN0OXyMa9cEZ6dklma6OSjCqFTaSFSVO5JcwuxJ3KqR6jxiquMtTJNp9pbkZWyi2JzCi3eMWWMFWQUnXNV4S6U4DIysiqWKtBprDFnl9MRLitxcuHn1a1lVKY2zvHQ4JUt3ozZsIaZlCuV0ZHv2ubPZ80a7hku3uEtEq9tiNQsZzFn7coSUQ1qcGVKctEwJB6dsC2q4NxIlmbgEuIvtKdY1ddcbxHKWuuVol0kJk+V1OKlMucz2VzyG+xaGVzt7mdHqaUQ4axvbphQ3tYj36OfVefhIi5kXXUTKLBXsu8wZo2uXnG1pYyXNXGq3JlyzJJNpaBf9uTKWnDwiXPVHRojleCnsWRiZpAPjikvaS3tRyKL6yhMYa4P2RtyohYiESKmcukpjOHTq9kjEKyYqx8yHxbP31ziEFh0rnQeiCSiS3BaTNEoL95r4akvr+KQ5emJTVnNTVOaEVEjmWQm25uRKqmfjZikD+vqzekS38rtB9ngpvKUTeHonycLyapQ6JHf86ugYxcSI12n7qWVn3ROmU6rLRIb1o/SWQ/niNgoC+h4XpfZGo3hEOYTsk/bWeyUTzIPzh/aGNgWcVVYrutKqegcDljWi2JlWI/dj6fxLl9yoK+sFRgp2HMQzGIwiKxp1s9gbotaXYevyfPVETePrCvYMBuqk7LoJVRqNKIyZaf4TyExksuMahkramoQ0vUOnHhYs6jeS5nt4BbNy6Ji0GmU0ZGPzfdR4wuvMLErY8fxVJ4TqB0PDpxQHLOZ7eGa018e1W7XWHKNF/MzcYnh5dEYqZVebWOyTDQzXuFtT2Tv5MwcKdAt2xaxdCEtJOmzHgyHmsyTLx7s3kWq77DZldgq1aospJ/gD7NbF+1T4lIlaDTi4DPRklVel3YYDY7xjuHw1iin3e7OFwcscOzt8uEOssv28Jyuk3PNcxsSZlqddKnaXDkP73lYIVnWHy3I8s3s1SdWU88SzGIISS3u0grOLc7onquSncccD2zYktBj3Z1oHtTgoaSxz9TPDtmtbe/qSAmzy5T0ZsxUMGrucQpS7yEZc+cYY9umI++aTtAu1F2fqeTSDtycERgbJQ4sSV9mLTMl62lezK4nX97p25luec/Z2t/m1kdliS6l8ehNsRX122IvEU70CaPoVadaa2AlL5Mq5fd2XWZQkB2TJ/BrZqFjpZlu1+SPmBhcDyQR6XQh5w4aXlKXri6U03dbIZHviGVgFS7wm5xYYC1TM5Es39nsH1iisMxsZPWmsCS03KFrXKqUE5Wimxjy3p4tH9YwK7AmaNjiYA3Y3d2U2I3Z8a6yUieRHXEamy/Rj4yLX2S3kbXiVeJl2E+OpzGxmbIXk/Zzm+MfnhdWLJYiJZdbn5iyJG3T5syx4Wvf3uoR0RZ6Gc4SUN117ernk3LfbY8wbuwxMU2nrqmVzufXSCjc6G/qje1t8/cuoavwpBaqo+VpMG/xYJ4LMA50otzPcOpg25ePYxwwmhyW2i6YDWLhNKKn5IquDqGvGhWoVafnJWpemIsqTxeY12/MVxKiVs2nHVaToeSQIV3eI05pYpfo8QxXpBOoUHgTk9aikUui7yJmzKipVikkrqyuXhXjUqlPjpwXDVHa8xTsi6xXV+QQ1yMObfTbDRlQaagcpCRLz1MVKDOQCwkrpavvHLETm+MhFqfcrGwKYqgPmzCQt9xkFxoioySyj5GitedlDwmMbWSrJLVokcqsbpXesO7OZbKy1JJy3SSMtN+jC6duaplqJZhmoiIW8pBbEzie0JUhc1IyD88VS6Fc586plxtVIHZRXJcN3aulJc8uxgnqEROadNiVj1KrbrNLCqVHh9Ps7rSg3HOu3qMt5IxpsNDSk91al5vTzx7upqlxUQ6XptYM7qozEWJ2uGuU15XN5Vfx0CUtUnMWFKtpKN0O45xxtB6TUBzjcAyYI5QaYJtUbpeyrKLg0N+i0eOxHdJ0iycr0U0xcZlhDSaQ2DHhMcogJQteGdrP1PYrbKXTZLAX7+zaJzEbLo005pmw5M1fqvMwmlRKi+flJ1ljkJmvnlwcT5GQrLKnKS1d8GkrWRYh2yhoT/UxqdGR9SWU5BbmGhqgoDETrFEJSaIXV4cl613FTucnniFdqlZybyFKDGTtDiuSXRJMyd0XEzbUN+aSaMlekBcSipQkbIeJzm+W8+uwtahh42HWoWUfZavZ7RQylZuoreecc9u0dRZJZKRo5WVXXVtu1ilpSixg5eku6RSLZZByNZFfm3AprS5v0t4x69KsI+BvmY8e7aUGKkwtoaUXkTDg35AW5iYbsivQq5EhKLEM0ynSU2RiY8oTbp3lYPRmC+/cM3DZaOJC3WUs39hM6Rvq3plgJileIu1c4BVvKG6qc5aUmFWZ8ao01e1a492WKavUKqFXJSDsqgYYlN5Y3uwJZ6HQ21qS5Fow31PabA+qmmjUi++x3prX4SSv5c3qrMtQjhh0bRMkK21Xa62gX2mdJc+qSXKU82IprtgRU98rrDHmblAOkqWc7e5i11+v03WSW1ygcA7YcrGWkxuz7BvTWVkOjuqwKi9vE/Zc7bJYZB9kDItV7OaYkBTjF7HVV81jtmboq7ZTYk2sZ82om7PpY9BvMW4o4+GjW9EVjfJosGpkzzDj8xMO2XQa8dLr0M3m5+hvp5LzD1Ar0i6Xc7bWzqHpTOjyqGtpmclhNZLxi1DdHC9faKcalPVJr6Ygn8xYZlPlKJgY3esaMu0N9Q5ZEXGqCFmLLWqQZuIj1i3So44so6MnsJqTkVdu8NpjFWYlGjVuqKRWFmVv4mjhDO9elbOPGQ4MF4xhJgcKKPMQl1rsmuVPb6RLWdZubiuwiZQz5G0c22gTGdwvb+XYl6lvqiEh4x8PqVUL77RgDBRosF5n1c9Yq64YVN0RYhkWZWQiK+ehSyfjS1nQHyxJbGqb0qA1T2DTaaRvi6QpCu0row0hn5lgygwvSBvoUpVqaBFWaGRdoxfl5ueYCOvcLYs16KYPTixUr9EvV+AU4XEpcUzYH2xdYiQrbJfyFnXx0xRhbAxUbOowdHUjqhvdXkxlma1XX/TlbQ6N9qhvkxmPU8lj6BnOkfMeVxnSb5JgGg5T6+fxMNulah2rFRRNaS3h2SxQWaZTXrNU3ZISU/hfGG0W3SUczPcU31ma5dofC64XVFmh366Ob+7UXGQhq6dux9AwYVqvZCsUYl4Kso7bz94MzBfatl4TM9EkNDSUmJHV8KF120rGbKfVIoymo5WaIFBS8y2jrurWVWzW5Pzzrlyi52fU1Q/WUxuoqOKTbtaNYOer2YipSdkw1aNK0hJVN2bWXarQ12LT5tjOGO1U2p8p0i6mpOngZioSLVhUitfI7FHMXY2hjVWzl6Tn6tXYzvPiy2pzDXRND6hha3CHYI7TYyOzYfcPjVa0Zy9N1xs0EguV4JrOkVzu43OtkZql0S8L75BljvBmHtHMleoOoWKRW12yHzCRJzEoWCiGpGdoUXXQOGRynq3qqZ5TmRoxb9JWIiNj19QTo6TpE51mKVIhbdIkb2JJSs0xG4sN1ZyQCXGfXaUK5kta6tgL891UkaSq2xZNH+knWt2zkOevmCSk15ekI9NrixKIolpS2B2RDnbNlzUX7xXYHqMvje6izlfjWW71HKVsnAygz2X7qdmhnrcVmAlYplJil2ttFOxZUEsvdHQb7JXhXOoXWI4mcAfdHSwiaGUvG6jWaSwyk1hZM8rU0YlLotCV5Bni3ChTigrKzR2aIByxpJJJ0LCho1cwX5jw75rYkifPNZyxJd2XjSbOZdwnVFDtW+boIk7mNHAqlRr3s5d2KxDeWZKecNJP65TuGdnT2lmYzOn1KaWQZBXdH2hdnYonR2rpGVQoyl0yImDmy5/uEBwrNIqsixeVElmXFptRIO6LbdTUH3vuKGjeXeyYTLBhDWENo54xJo4KmIyn5qEtmVdgk5RRst0P92KwludLUvOx2s9RrrRmEZ5qzxPkbqAoVx9U4uili6L2Zmaw3w6wDXW3VCUNjQnIaGudTw1zzSAn4usPKeXqbW1lakvUtMvuLi7eiuzgZqgKI6hvWKcs1c4mW24NWfXiYZvXrY2aIrCoVjYcnZJUMCgh37DbWlBXLFzcTVab5WXSGixkYKFeLhdrHOO0HZmyyrKIcrJoshLSr0/UsSSZ11abXRVTHpLkSl1S6+Lv7E7mdWAR22OKLgbr6mEi6Kpd5pNtWiuRCYvl1I9RZRcoYAylpxWSqKbvTrXfWRabEaqZK+aV8Sd1Hs1rtJyxmxVjoRms5mowYSchs+ewnUxzI+VmHotMlTDIIC8r6BVoWVRe6BLSolTWlZdpa1JanBHmIGtMsV/oDgstWR4iqNzPoWryaCAdJDDyEs+dUo2n81UMoy0JktpLU82L0KpdSu8f7RCPL9miZs3X9svdWF/xqFosZyujFSnS9HJtIadkTKlr1t1P5Z9vnGwemFuRK5wR69MzE5UUbJYTYOxS5ExqD7gTrOIZVCcskTu73hmrbWPgEdGV2dU2GSjg3WXbnzIzYCejId4ZWSYjS6DuLtqS8FUQGrYz3FjnJFYLqo8v0WEe8HATE1A0C05mJZ/3XFNUqXBW1Fgvq9VtXtnxrYrWbRTK9LDy2OAd2RSYE+WQTVTOt9JoYi3xlRcL0B9gjufs5dhebNLgMyBtatiVGAyaWq5NZeZhlxwukqhqnOGvdepPdRq1EjVbo9ysc03w7BIkH9XralRQziLpDo1dVNUOq6yoJVIWZlJJ2+9hWIv3Y6rg5BrM2FufkeTU7B1idcwc2hkZUlFXM96jFlceIldvn6vfB1EQ9tJSHXwQoVHO2F0Xi51OKc+TIutk8G8JEPEi8RrkZqLm85XV8A3y+ErP8Nlkok8z2CTpGpzhrVZejislylzw6ubn42gZHZdusa2PbOCnYGCcjRgck2AvcRr51Za5j7OLqxRj1hAgXRDW1m4KkxfoYiB1aOYt0FEMUV6O813nTJVY0GNR1g+yVV5gXfUVEGefcqUy5KCm4xba2e+ZWx5Yl3Bt8OEZYGMoaWXjy4xe1M30Kxnd0vHQca/M6Vzm5BKLlzWL341iaOydNJsjUeVnkSDhEmVcC+6Y9KXx6pU1nQnUYxTOTB7qJ2ziWIugoF2t2cxhjOlvky7mztH1Ex2e5mxzqOlP6kwiLFpQEBNPy9YV12kOZNXPberjozItXzhR7pPWVezhjWgVUREobcmvGOUV7PBpaaJZBh9OKGYp0SWt19DvoZ3jJtYJ9afgVLAwYulfTO3nzymzVQzU3RTb3+7gy8rq2+Hb2HQhnJvkDDKtYRsVNXNyHU3yjlRwYJ1N2m5uK9PeIehjydjOaekqDhvPmrMXp1iN2ZLvl1vV6k5ZUc/PYqChHdp20Jpo1ulPJOELkPOh13DNEpNuLl2aWt+uU2yjb7MkSiCkKpTvCSdLmhm1oB2c5+QYkdY2DFrwVVZfVqRx0flZS+8plPUo7V6VmJiR6C8ljvCgr9EIDuL0c1BuWFQZsuEcHWDg35fkTy1PnlMha52sTR0VjdgUkGux45vl5yzmUWcwW01pbUlgLmLgYNFmHF1qsqioHFvdapkwtVgmZp8dU3EbdN3k2aLgbKALWjHdDh6ZF24elhLoZ1J2GB8d52Tl6mkaVCQSmzfPTNUsc9qe79koq6Ws3afwq5Wk4aNv1BgZqGmdMVyj3yrbrZgp7JatK84UsPBjMKmbUKxmYJZKF+UZKa3YGNKTUXSXkyshn+6b8GvvTXezj5karnLRUqSSVdSka3OMb3hhZdAn9Wa10/CMytHwtI7mVS7b51/ri5eoYUuiMbDjhmw1TV7e0ibY4i+1iyWVsxGH5qNYHJCs4FQUtXHm527gT51XtY1LrZkrklCQevJa5zBo1p5KLNQsneUVUKquz82eb6Fi05Yw3HDaHOiVmdPLa/IqYivd6NodthnQZBYj8RwKj6NwJ5enzRiaeSG2DNztXeHQHbegMrLTStyrYZIVVPQXnKEOl9DkD9btWLAO1xgw0ZNW6hkgabFKI86b6eFSGBa4VfGPy2hoLYwsNWyhnuqirtXt52nP2RznoRDfGJxyXaUsnumKFePf4U5UbB/hmVS1IkvULtXKcg1RErWND/XMX2Ro1vCTruVp6ooqsZvm1dXiFafb7Wagne0WZadukipzZwhgqSMubeWnrZSV+pudqJitpeOlFbFqnc5XK9HHaZ6Kyq6nItFqnybxiCfeTfOTGrUYICcK2M2fqlfwaBDXbJMeXeAXTxsoYZpgEuYortwTziXzH5VX1tId7hmPn7MuzbGU16BL5ShcWNrMbTLjV2ALq9LN9TMx1BvM9tsga5Tq3S3TEDDulhEtXmlrUnLLT2iX3fNy+liiUpzfzeuY0KwLKlfU2yeokg7N6ZKJZWcniWWlnWmjKc9bkO+eV9lTOBMLU1OJZiy1GF+pcGrk6iCzG+JgLC1vFGeWGy2REjAyi1Me2CKm3hib8pJLmywuFyScWLQY3SlwItHUcm2sKSvpnwtqcIzTHG6Q6kyuTa+ZYLNjHxVTsAzuzRSOYnFmIo2tFHTYam0tUcupYySp6Kmrr+aZEuzo1CNcD91OZOkmmyRYdIogj2In9ZsS1dAtqu6qs2r27KTSIHgsFqIHZOSH6SWkVm7T0quxcxrrXw3kU3GacCMN1BXn3SmZMshx59RtLfIj01FUdA9xWOxMqWJmHe5tzmL2zrTr7VknJLKvZ/RvXmKNDKcPeFiZDZ1W3tfjbBugFWlUkKGhVZQRryOqmNdx3C6qJtWblxx426vPJRkXs9vtkqjwWB421Z9onvNWEiOtTOQaIpssoU5MlZ7XUevOb5ftUl/zLg9Q3/SrG5Geq98Q3JZy5KJSD7pWUqiSbbETqxdYW5+zJSoLludupOCmZYxoUp1hYqrPJ08PmE+LI6PZIXBopMcgkqncpRLebdvQjFQXt3Dkd0qO6bbSbrMOltlnE2QtbaXqSpQml5tpY6gq23EWneQio5JwzlKW6WmjL9EUmunRs2qkUxDwnTPOkdSVDSNu5LXmnM/ylGBRFlAzKyMoTehJ8qP0VyBhFCDoJPJzZ5NVkNUyMCbdkaFdHt9WsJLnmGzaIbYu8NXgX1yajB5WV1c12dUir1KzDl9iYRYW2SM3DdaVD8wvjp2VXwuioDAUKZtz5VlImdKWJXMOYSCcoi7XkE0cLaupLuTSy8xs81Hr7e9IL6JmbhWjLWXjZOegbrRszh3a0zFSixvOEjWgMhBTTKGhE18l2xgTmpLk8OtXNOaVrBsdnF7sTuO0pGdnzqcUHJyml+Jw0A4dLB0sISIL2mxkLophmB9lcJbWTlIQ8S7czxUYpTXUnw9aJ1Otnq6UKt0WIcifWbRzVl6ole8tFOwW1KWgU1ZuT9xYEiDdaO1RG9vpI8/Xc812nxsQcWOpXc7VUNqWUg2gI+1sJx1qkKChmtJMDXJp05h1VeoLptMkz57X6uFRFqKrYjhm6q9WdO+KotGr0SAV6dlXKqay2ezYG9DsLeseEtdZ7ckKjhtbXisn2IwwDNFW3ShwdEzZ4hqTKiLQ49av6y/JZ65yBNwiLa6Xpm1crqqiE2yoMC52EqRmFBTuq/YYbhmfmedTrdHcalJTGBqhsKh1lI4NoNZVYtHhzg7mqiv3cdsh8JAVH3TpT2fmWN/dIo+Ir2wuinHg4l4SmGyYsVOkTRFcWXhQXptwHS/pMFVVyqNdKh1eHqhSE42ojBhTkIpRUR7Qolnx7GlOi4yv1KeLCp03sjKfqEhsoiyr1pntSiZe9tVh59xdXK1eIuQuG2QbkCRjoVeLIK/zGYtUtCmaoBZPXDC2NAoZYXJmzNdd7O9w1QtLLK2oTrPiDeDPcRUdRQ1kJJGioMmL5fZSKnITJlEc4uknFo1bmKEnG2ZnjZOX4doaZ7HXUK11ytxR1rGboFmwYMthFEyjGB0iZvCVkZLqVlOg3tic3G1X2MkVi2qtmZwbpS/PxtfUSSfcDtle4Cnn8S8qJwqJqBvtkXTdDQ4UcLTrD9bkVrTe99gPqs8JYEWXr+/yaGjSK+IwzBohTfMUryavo8lno3U1z9cQH6Vtls9WVuIoGvFdt51c5ucPrlzxIDEpVVGNjqYv5WzWJyllkRn2MJrlX10RMDQSbyENYOdul7midipbnVXK4uhNEh7fGE1vzvFgWeMYEzB0WXCTtRSvI3U2nprwVl7wJ2ih6SKN1K9lTKAPcNwtVE9WFK0tmRiQ988ca9uUbZ0nYWYtoa4l4yEYDY4h5GnWUlDcHRXOrKUOL24W4I/nLijuVGLr2NKuMufy9h1N6exT0Y2nHSysomIi4dZiEVBWI8zrU6FPz+guHbKToBJnKeMK4NoV2KhuU5ipkZ0Ns+FtYtikTmnW8FFJnekSb65TWIrcUypnItDwbeMn8y1hWDTmVVLTthJMZehXMW5UmqXSqlBUENGxHBvL0a3wkqIQqJEtFS6nnW6qjquNpu8LzDhNc6SRWNFXkBFamNmwZCwvTmAxjnQSHaEzqK+Z1NFmi9zyjbKur7Dvi1DjDN2vaDHPaVDjolasK+RpU5Qm6kyOYU6ca+dnWa8W78pPGvNsGyrUkOZX2hcxUuezFsujlSgLbBrKl/cb84rlLNt02l6j7xqxm9aq1SkjaxNysGde2Bsvyg5lauJH25gcyOMXFc3nkWAeMS5aTJQ3Tl/21Va3ytU1YZhMopeN5vQcHaHlz1qJ63DfH5snZNcPZKvg8hTpcChLIa/L4tuMNtEQLpl20HDNKtBZkaxr6FeRSNfXJ+qgq+Yg17Ptc+jwlA6Vm43v2+kNjFUT5BriDo01K1Pzku3U1dmroSFXpVWoD7KY81KbrQtxH9yozlEw11mnEg2TnZn2Dt5hTydPkFPlTpTj7evX84vqnI5W5S8ltRcZDI7Y5tB0F9FhH5SUr2Ih2ilai91iW1vPl1hkLFJylkZxsdpSaVLNKx2qTxPeFR2iXuZl1LO47A+OYSrPmE8POVQRK6VOd6te2KAnTp/u2atg3zHg7XKU60fWLefJrewGL4mibMhcl3FY8fajEeiT19PgnBILsR5y2tmn8uGgZfDmUrDvTmL0JRxh36HwDlJjttbxma1V1JPmkWETcrMkLFFSNJhRrE6eEyaJZjPXMO3ojN7xFmZUGscG8dZQX+HykU4sG1Wg8eZnMRTQYG9IVOlLIzWZi9skD60zmR5d8jcyjlSM3SvLLk8qU2ejdAhy5+fIDqrs7IwoDUovNXTS2nGxy6gKH9XaXiHdzM/ypuyayetoNA6fDTSVhtef8q3YplYxSipel6u0K1/GqM3zpBLYEtmXDTOF4qzWb+BNmS2NmiZPalRorGRMD6Hu8FczUU9skY7gLh7qcRt3kHOnzxtSXCrsJVLej82v5fYSaqYvrd9h5V9IkvHmCspg2Jbc6Q2XyeaWqSyqJdnrIbOcGlPQdaBmiUxj2FCQVVarLIlRIKaZcF+X4RZsLTOl8KHkJ3DeFPCvsWOYGy8gmpugEaRyWF70mtPV85mryw2zlVJoJGLR8l80R6dNnKxr72zlHR1pI2eWXUnUHp3gpBPk6xAx4VGd5bLOseFRLlC4MFxsF2cfm6Fn4y3tLpdPyosLL1CypK/sXkivZJnOnybnLdStUdkaMazvZG0f8VfV5B0QEZUO6A7QomjkUwynIJ2Rodgc020QaNGTqJ4StCVJbF1L3A0iypbkl6QKZlVxI6wZmB+bp64vV1bdFE3b1nNUZV4jn28OksrMF921I4rkSthclcmKJ+HVK9IKixubbXbdFDF0DhWi1/IrHskWDeZf5bWyGLtW2M/26Q9u6xVt7ZBZJMrcnRstjxpnnTMVbk8S9K6ebVhSkSl2Tp1XR3JSE25w795zEvVh2emMD2SqZZyeibCN6a8Kmq4wDV9zXqMgklLcE5fKXV0Pm6YqbBLpI8ynEHASoV/mtXQP0VZY45FVrG32EnCWMBFyr+FHH1+py2HwtSAlVigdne6KWJ1oYtheaPFZ57KQFm3h80qoZxZ2YB9iKwqSq/FlsWKrrR6aphXjsx7JB1/ucBxRGLfXH+uRbi5sTd5sU+tRYxDyI6Hs8skTZqiIcHFgcmtemmHQY9aWWehRWAeLtcuSE2pgnxHSaJ3mryBwIGPhcsyh3mOnZ9uRT81hK/Wq0htZ4l/r307acA0NGm6gJZSfC1sP1o+ZHJMlUtHXMAplKbAoXWrjFhqKy2rjr+EeHaCPXeLaLlYbEycp2OCk9pcZGE2R8CghDPFwooiUq6czjI+YHPKmoLBjWPWRGdq4mOVMNWNrmZGLFxUYrEhnXa8mz7XQEM6lWqWw0BERLlrT2xifdBDY5BShzmogKi/WKfXRMaerLRNQrqqaLminkiqJ1A9TqWna7dsok+2y5aPjD6te0PFamiBvcuOl3VRzI3FYKtzYMJ+p6atx66LZnNtny9YmL6kwHeph7iDiqmTVzuoSzifQ726Z8GDyViZy3megyybajCZd4uov15pTJmKuXIjfSy1f3wtPzhRqaF8tHKW2M2WmHVifjDKi33Tw6Cg0EBTvqx/WXBVL1trnEo3LJvHO8J0Pnm7cFaNRnJCiUeN1lPZpIbSzMy+1jWQTGgfJahGsLdOxliRhZHaNYGXX8vpMi6maHGgZHeDlHfArWOKf5lHirJbo1Fza7ZiKGVXsU3cobmLb2fOL24rTHU1u2Rrmdg54sNcgiekxqmWZ0vDZ39HnGTAWzVgNhaGQ5uGoy99hcmRL4qfaJtbaE4/lqTgi5eRkMlmuGhFlVhhmSe3hLPfOpmMwoHDqGB+lUKnp2Zk3Z0wwL46qx2vtpHQS4GnlpyjJrU7UFkzazBXq3pBJ4CHRVBjR2TWzrO1pja/1pKTaaZywEdlc41gQcR4W4RZj0pTyEStN2DRj3SaPXJKNdBCTi5XY5CpiMZDflRFpZajj2C2SjuTgM1IZVPKxVWYh0iyh3srmNZ3ToN55W2CiTrQtWhtpqSLmDDJXmql079GmkO9N8VEqp1834xuzkNu2YCUJWxpt5+mNkK3joFYiGnDhqFhvowqlC5S0XuwuZy7cnhOj7uXi6GrbEmcNoR0b3zHu0KZLapXN3ldereRsVNlsRpmta6MYHNqV0JOsqCotsFEU3d+eKNEsdauPMulgWtCVKylSYtpbnKcjZHNb1xdKWxhzrDZRcNuXH5bM3mmJc5B1J69wr5R0aV4qnJROHQ4V6prwG1DdZ9ohsxoWkZjZ8c2WD1frI2ZwWBPoaZd0a1wQS2Kws6iY6OlaM0vOjzAta1UkrRwcj/Rpo+pwVaAY9U8v31C00VLm3xUcDvMtVKhkU6o1KYom3aGbJ6JiDJb01+iYkttx8mUg6yTTmI8fKaH0kCTv7N7MpeznCxDRaSbeaYvo4DGm2uvLLXAtphYPjvT0GpFhoGBt7qevSwvrpPFoa+afKLGg0Y/YEZGWjtrmzs1eyd5jjYfyMU6NDVOrDOQpZWjsk8he7OZSYzHqEDBpmzLty4vfLBFdrI7mx4pllSGUYaxeqFWK4hwnWFN2L1KucXDeCtffkWOda6hq7K6zY/FfLmoH3Ssq2FBcap/OW9u1EjDt8G5qTCDs79WzahxbbFgSNKp4bWMXc9SP0E9O289mIF4PVDKg21ARUrEk2doPWtTS0Y5W8lQxj2CP5lbfo9Qfmri3F82RJaOeZhFrmZUXJ2POIRkhT+VnIlAwtTkUqdGfMRZXUycjpQvoHanY5msgiR1XpOqrG28KUZBfLvLaYpDRULYiLXS3lNUiqVihMGHcYh4Rpy8bqOqtyCJp3ssqlJ6g95vNFXCPEeznMdBpnVKSLLIh3dHVUG7hYRUzjAygne2S7hexaU4hqtCUSvQc8Nkh5CMjpuasC1/bG7UUD5w0TB9XkhKiEq6y4g3Z0Vlmyq4dJLLcmOIP2/WWcaeyy58W4lgtjfQJHKiKH5emGp2NpGZSTSho0xELWjPvyjDNKtoel08mjXNvWdXVVx2aUPDhlt8yI8XQFKIG8UiV39yr5CLt3x1ziXSvzAyaJJUoGdrW8CdL6KOOUKST2me1m5n2kNLNcapgorYVVbGLkReltQrZCfQw49H29bRhqyRwRiRX3tAxydvaVSpIJYdnqZmlDaNjTtjXHQ1pk6ngrFNnkq6gJp1lDGmb2gvRr6qLZyKqL1srXp1lTmheih0Woygln2ZZn+1amSF0tOTwn9DNITExphATJO6sDGKZFGiFUixnkTPR6Z2cjaLSX6+vy84l2jNzTaRYH/Syk57j51KJJOZZal/d2vFslE+ZppEx0hPO0ent7ieimOahozHyagpfU51XbyITSvRQcKYN13hfm+zP71icG7LsmVyRWbGUEBcUpGqQk2Cw82tmLkklq2lZWB9xcvIiLEzOj/FwEY0b8WLN7ePrnEgZHTAZiJrtmW+iXZjS69pea2CLJU21WBHMFWEtIQ/QX07cYRJTLREI380yzGlPqugdr9Apl2tkbPAxT3CPjbSl0w5Rzddc3dLOEiOzraTP9QxvjdHXK1ARFhdloqKt2K2e7ePLDDLSJiHj0lkikN+vJ6Huaw5inIy1at7tkKAhq0/4VjBj0R8dTpcz1R+p0Ky0HYsu6NlWJZIMoqU0zwxkcK6mGGFXYNbhFLKO5aCwTqQPGG1ooAulrl/pEFbioQxqn2EcWuDiI+/epF/wJuUoHmTYFtveZtqTGNofHjJbI4uuqg2ZZm+gEyqIs6Ln1MtoNmTX1iGnoSc2jpiV35wM5yWJnadMohoSHJkOqOrkjlPwVLDPETBzUJORLxRxjEnoFBCoz6EqanBaZJNnEdh0YzX0rV7p8F/kUmMvpfMd5+Nt4eDm2NWvnKvX5lEeYc6M0pFv51suDl/vqRBnsDCUmbatJmnoXewSrVzip2Lt5JASHBvYZBpUlyG1ccxLC9LYZ9dungyQquAiSmjkjHBu7tTNmZESGqobzY7l83SeYZbvq+1ujeOT428YcyhXk2s41zvkLSHO8hjeHd5QLg6oJqaUyuy08W/ZmiLz6Z1ZFGEkJRpzU16rk12YY6lqDfMMXmZjzw4MIgxMIQolptTsoCPf4Vgxz03ZqeZLWSUdYaBoHZ0snDNcMp6kGpBbje7Q4DFOiCYh7Il1qlCfIQ6db9KJJpEv6d7vHlZpIqvH3O2ZbI/RqFwsG3aNmZ8kZqtRV9mZ+Dei8qXq2iNaVQvhqjCb66Qs7mKODGaMLeCrz2FLEtjUYS8OE2YfDfCpEPIXaFMLpqKdW5jlzVKb6+6f1bHRrGcT4Cic70veTeLxItAjtI1jZXJedPcS2mTTdCWgqKCpJ3cpWqAlFIzk7VpMn1IlcBpHcBGoaa+xyC4gXm/t7BeZYNWfcJq0oIiulmriIdJcC6pVXYec4iUosw2nCtSyT5LjMSNjDxaS0KKcHo3xXJ2Z6V7O1TK1Wt4fB+hTpO3vGCzlqVoizIqba9SSJt1VlGuvJuHopE3RsNWa8/DZqeDT6GerbrcR21mjLKimJpMPaN5gHK0OaW9l6EphYt+yEtDS7ZgYLKHTT6qojDArqt5x2atWrQ1VrpatZhBskChM7YpNGqcfK4lhc6aMY8usY6alrQ3S1qMtdFtvkg/k2Fq1jiErp90YYxFwpNpjHmlas9GoKGKmZOPcU4mMXIztotjYZFiw1ZgVdFsgTs/UF9TnrkwunSCV7u/frR01LpiPbVjXqI9bbt/eyubmd9O0JTghdqfOG1cio6YwDU+dLxpqJeU2JLJWotjxpJ2u1CERXlMds4iqYu+tcNwDqxjZE18aYyPoX5cgnm5usiGZ1itUq9FqdPUTL1bV1R3VdaOk6d6yli2poFfYkUsh0Qsajy3tkp1L5mmS4Fmw0+DwJWAZZkugmFWcEeqnaS0iVlNu41NgsfQqsY2OEPJRJJQmbPOcUlRmFGxmDeTpYWccpLKoIFVuKLLYXOCeH5hVdNjN9GSG66WlIRAwHKAUmbUYoJBjHBY1LaoSDdbQrlFitUtcYBjzZJthrxWfIVEo0o6m17NVFewTdNYuVNdNz18PZF2n79TvDBlO7JWeoxkKbWtVaedV51ssU9lJyi+0HG6SHc4xzupUNG2VnWw0qYudXR4nn862W00vXuQm5iGpVMpu2lCnTXdt5F/i1V2xJFgPYVUQaU2o7rKl1p2rJN4NVJiwat/RMNcPZPEklizVEFiojGaYag2MxqubL+myC6VcLKKlMeCNitL0DNXeXU0ql1bdkI/MoS5cWNQM7FCu5CsdGNTiCFVnXuYbodFi0jLx0FCgz5ZiKBlaE3CQ128pbBryWGufoBqQLdjXUdAl82+b01rHpipU6wlGijSXZlL0MlTo3teuzxQqUipjm1zxlWaZnd3Z69JdqWFx107j33Njk9Pw1WlP82EgGR9LD6FRT9UrWE3mjemxjaxbadaH3AwOERxhZa4pCAoNohPbl9WqsExvMiRHiRYe5J/v0SqyFZyRMYj0iVOrWO611qR0Kx9uU3EPadCNLDGzYGZdLuhTYFmHjOxg2apRl6/LVwsuZ+cdsc4YVCuWTdGiXvHXnCKXkzRSUm7fnYqf0qbO2WuaKpBkYdl1jJVuXl4y4tnib07kYtRyXKrzUZIi02DK30sUjs5a8FcUy2FT9lbZ0aBiBShPcpbRbaJklTWR6ZCmD1eX7yCP2lQQJ+/YbhDJzlUReS+R1KNisTJmZx+yB+lXiRnqqRcSGxHY62SpKu80pRCPmxhfFmGXJKOqXqDy9neabgrbHWuRSllzXOLl7itkkVaKaKonK95adJ1W39maMCNU06KdWO5V1mKXrwqV7d1ftdAWX9Fn4ebF3m/hT5id9tVR1XSby80r8HKhJKSZiV6jC6LwIWNjl+ltmHBSbCownTMWYEsr6tPpHM5kVexPzBAoLqVWTy/wmy4zjfWlaatv0xngoJMyDo6cF9ueLVIfEKrw7xZprVworY3QHyimsK7xFqqYDrSv16GQoSUxS1KmHIoupx9tTV2uW68M351Y7KlOpu/R8Sgr8LTS1AiejGlaDc12a++l61FKzyFem1SenVZe3XLTpB0XUFbQ8FEYS3HYB6NNzaUdsLTUne9t7NFbr2hlo9WXsKqc2CwYUrNsqCFzHpiOb2wL5huwsdBIqy3lX2rYo6yK2Gaoa5Vkj17VHVJgl2WTJdBTzyDX7Aer2N9u7KsMipONIqGn5DGe6xas0ig1Su4g5a446OLUb2Ef4FAebXKod6EwGipu1qOuW7PaomOv3SwT4BVhyrYTW2TaU9gxpWsstBQX2tzyLSdf5raaWKzWL1sPR9nsM24SmxkmbC0v4OqLlTg15CzxHnAekzCUZZUa0W6T8QtOLqfSrdnYtbNXqOUNqylQWCspmaBPjfHtHRYcGbHfmC8ubuWY1OduGVZVz5YzaCJU3zAOXNRqMYqozilXHVE1p95VY6owifEPKRwd2rUNNCCsIZ5iHTCmyzNNTOWOnupg4w8ZFCcy8NEh4Zcr6lzTV2cx1mffbjCP6B+N3pAg9e0W5+KTIBGv4LCr0gwojCItW6kQIBEdClTfZw+KV11mzyLtIewRE7IIq9hPU2lV9ZWcESSwTy7zGNEny+jztGDgYAsZy88eeqWz6k1YJWbma/KPNKsgDdEnGqcc1t+cbLag7SvlVOhyVnA2k5R0I6bk0hkf0alox2CscelbGWroVKiniV2Vp2+b2R5zYx8Qmu92myFl00wKT5vpFyKr3qZbXWPJGm3Zb2TqD1Dz6JBqzyxvl4xhqy0Y5heTVtWVICmVHe+zUt6eMAeVIuqqy/JyiW0qM44P59PVMmFnYU8fymxrDbAj0C6djdDeKQ3eJRPpEeRr3K3PGNzg8ouRlK0iZcyM2JZYHoxt7mxbIWglTMoMMW3QHqCj17YUbfATMuZQqxkQDufh8KDoyuUR3+4bp41To8ca8GKyDU8IqG7Q9VwfziJf1NSN5mLXVGpOY90uUCQY88u1HQmzilmwXLXrHtAaLXHssaqmzVNQKTCNjBEgIm1RcnDvF5u3Yx4a8CDjTSIrUBVPWOgrtK3szVAl0eATlCQdYHVcTiimbiDx3BcPECMgo1eUstMp0k00G+0PHKqPGvQuDlllsO1dTpwv4VUvFdTwtGClqNPWzOMqoGmN6l/LWZ6pmKmwpB9vTSiZG9xpmJBsnCfhkagJGJ8y2DjaGldmi1uz7tvjaNVTG7GXHFyVl7IhrAwRGKiZrCqp6QiU2DD13p5pKmpQUFOVlhbojW5ojp0gFy/SzKeb1jM2MkjH5uoyEVGwWUzVImfLHZ2xnPexnFuUZeGE4VbXY+tVzGfVnBCMMPcfWVyR2l3VEm+SpiRdGcyl5U8NkqnxaaJuImDy3FDszF9wmZZhpRVzqLIdkM5ipgpPp2pNyt2kJ13vC3MKr2cqI+hhlOopsW0o1hOw6VVd0BtlYfAQ4XI1IuRVoORhZBFVHCDdkyISTNJjmSCpMY6KFjIldfMnqZ3TNZCWmiYsLalZbBzhppRvnWMdDNKkrS4zJubgdG2Ojx3oJe2KJWykG2+H8eMimHOpaWMbG6fdURzz2C0IbNTq5auxnc4S8VCddNxYkOHJXe9mVU8VUONVGu2Yh2Aupt1VW40MaHFzsJSx86MX3d7nkNpeqBBsCq6jl+Dv2lyPs4wPG86jy5hs1B12XpwY1RJlsosc0kfSdSfmyxQQm91nJVUsSaKMkdWwcJLaC5qaNBneIN3NMRbkkaTK7xZwau3eFXUNM96Oz66PKKxUTJfqVx5h8FX48R/Um+QwS24HJu1mZ1Zo6UwjYbBOn9FiEWyy7WukKNef9RlRznIQk5mW3BPu3qwLSaeyV6htoFHeKNfRGrBmqdckFSUwGlfNlSJ2r5Fq9BSKLehhW+DYV29t2eqzjVaVaaNn5HMK4BqajdSjdxecUy2briUnzDCpV9D1aaISnZPrcaivjl0rWCLKMxjyoSGflVvflkhgn7UnNTAW1m4VlXRYYloipePdLHdWZe3lpadYmDCcE1UVEp8pUpNWCxQoXsvRbZrd0xsmG2EoTI6yGMjL1pUiEiPL0lgTn6cf7e5nsypfFtYxZUxssPVbHJieomHn7qwqj1wgk1xgmtHRbJXSMijPrpCzV66tChr0LWoebRobbbJR3iCN17BdGp2Zce4lzRtSnImKih83o8/XUupZM1LMsiopEOWriV824Omi0SPWIWCcFGh25SBTMaIVnmcgLvTPaSnNYCOikDOoSU+08pe0S1tzz6AzFwuL7PdbIxK4TsvM4+XioFXo9E4m7MiQVR6MUbAusSbymi4U9ZBYUaSwWpzU6zE1pzJtz5yR765R2GPqklcZMWQbNFJkGrAxKO8x42LMZ+TzH84g3KeWKiqpX7PzCk/kVZGMY1uaYBjsTuQ2oxmtaCsmFdhrZk9l6h4MpaVRrVBW2VCuUadvzyC3mLBz6pwVstzz7BEvTp5nW5pZYaBIbeunqGESj5+nnNRSy0nV2dpVDqGYIdlqbgvtUR33+KBcY+SmnmUJp1Pf1S/YKx5n6vfQy+3mWlcnqyso1msv2tBN6NBbUTTUayXtL5qcmw0tcFvZctSPU05Z5rCGrGTbdNryTl5Rr4qkMhdg5NJZeE4z7iKaz4zcLixf5NEnGmRSb3NLUPAsZZ3nolGMU6cNTuuk1nSzId2niU2fq5dkooya4p1ojekX0jrimDXkFqtPsqbbHXBy7GJKLnOgHFaOp+vzzfKo1klsn+YksWAzl66mYJNmDZgX5RlxZWium66Tqe1gZV2EHc0xLkvmCKRkaGDpIwYnx6FsZSbW4Vu0mhiiip9XsCoge1Jg3hn1JKMndJycJk2MkE/2CdlnJuSZVA6nKXWgKNkLXqFxKV2rVQmgVervzzMi2hzXpTYkTWqopnKhIzBTk5wMqOfJFgwy5iYYbG3sMkzrC9URk9xonFDjYamY0nDjlY9v2fJmLa4c528hpFUnKg2lqCJiCy/XiZIcsu9mZxCvzZQW365p046Tqmxg6ZaiYV1okViKbiHSrqhYLFBg6CgLVJhRIXGN0SikXaRzjGrejbVXqxIjnPFpC26wZJPy628S1aEp2u2iW63YUuRM1iydM6PhDiW0JdTNza9pEZDS0VzUnVLNIKPwUV1cFa6n05gQkaPgLlfxktFwSx7TTF4fJZht6l4U5eOT0CiPadIrDDUkmBecn69YVMyOtR3o2TJf71lkkqqv1uRM5RPh6XFNW1jmSWBmMZDSM1jjNk4UphjQ8BhQrllz1JvV0TLc9DZMISvI8ata0O06YhHUrUkr7wwUmNfPnVd1GuqPL/WkGrcPdOncTp6jyhpny7KpLZOi0HalrB2rnI+KSpJnZ2og8lMJIUuYoLIUGGIe0zcm00/0YsnbKaLRpRJdHlsyn+Gb76GSmMnRzZWg4DTPzivh37Uc2jCjTzEOT+hmL+IbGVGuWVYhlJ/XEOul7BOpmFMUUNbxnuiPZqss7GjlGC7QDs3q1I2fTE9mGAzVtq1ZV2KPErKS2ZWWZ2LeZ+jis9/P2KezbN7L1iivjmDY5h1J3ZcgbtLY0AzwkiDq61pNT1wnJBAjD3KPG8vhbU0uFg2Jbtswr5CMmgqtVc6h4ZmZJiZf4RYarO7X5wxpUy2T09VOC9nvjBla9k3llW3riWJ1sNea3d3t50yjklZaj13wUOlQN5dSW56m5c8brDYUjV1nm7CPYxoSjWDj6GgSVOFroi5kl1OSzpSx7NIlXUowdKULGvCUtXGv8BBwjU6e2DWQNsxLCGPvapJYMtwlU+WeZOrnMrYeblWh2y6ULBHQ36MpFa4gmBjwj5khqE9Xm28TdDMuENOr2uRxtCswW5FnZZxsMS8und/yFW+Inw5QN1xXE6Qlmy1y0BSbNI2fGtUa3GkjqyiLaxUNHZPlbWWIZitPb2ItzRZYclI1MUoMEI6c7d6dFk4SIXJVX2hp5tUhbOEhYVjyjmCUJd6Q3l1TMLFgLqGzmFqX6t7nlqBPjY7mqR+knyNZYFKQlZ6N0SG3Y98m1Fphqa6cMUqLo7Qgzy1VIxAYJ2uV1ODUUt2w2hgW8GcQ5WnupJiQILJUqeYizCyOnik1IHjtrSdiK55PqjVKY1eXFxlwFM9VUeAvVFfokNglGlfQ1PJMNGQnmVFVjPNxrZofUZywWxtqHm60piusj1EaMakf7s+dVWicVRXutzaujLca7c3mmCH0MlMXCVrvKx9bYnVI7msliIfx29tln9eXLPGMZ+wWUteUjNidtA3K38+tmhqddipgphVs4TDj02RwoO/IpSWdqNPacOqe22aXEg4pKK/O11b2s9rl9lFfbRNg0XBt8+ws79CzphdwJY+tmmciU3MeWXALIZHfVNE0VJHPLx2OVVfddSqhXluJ7KtK7FgvW6faWMuSjLJqzDOUDaqlGtOYIVIJFlTyXtKTllDXahOtCWXccePlLBWp1eTYm9uals8JIdmaiYtwDxCl5CFVZiyq0yzipG8nExbk7Azr2t0wpe9TdhjW5V5KcZXG6VGLISgLK/FS5isQ0Nya1fYMJh/mZnCuEhrVcVDRc0kybAtXsE3WGRbcWltcznFwV2UNbLCYoGxL8KhIoKOj2iY1zdtZLuSzVvV1DZm0qtOkG6Nj3RqXdJXWVSNQdGuR3NmjsmepJGooL3YWMkpRdJVvl5PVlija13SaEc2Q6ixsMZ+jtK0VHuPelKExyt5Xqkmkm9nXYWMttCMl2VHssuOWHtvhEe0pGOWaI2eVWR7b0m2h4s/kiVsr8SWiWBqr0EwNqHJWMdZe0bGRqPKI1BRupc0kE4eoqpSj7fOdJqJuoVwn6g8qdVOkKBngEcxKhqgi6S6by1n1ENYlFu7malxmlpnG3zARLG3p4pbR9g1fc3MTlC3tHe6Wc1yZjubkE2wgnCgpcx3WaR9Z6WhXceRLHrD0kk0j6HFUjKDjDcwKbjSfUZ3Xna4qi80S4yJPnLTTlJ30iwrLFfG2mSfkXVHtDbBw405jsGiq0WdlYQ2STMsc6lHNmnNbEmdGk64ZDRkVI4rQdSBrIOKsneFaVHYNKKzeEQ3fXc+pNDI1lpcoXvBt348ho4z1LiGzEOZSrqUUFzXx55NmpiBqpmGNHadha27HqeiWX46kzC+dJXfRZS+s6iqYMu3hZxUrKKCUNyEckbNlC9Uppd9Wp0mPDguPMw7gmxncXBlm6tVgm03Xa6QSbvRy43KYMxlV08pcqe4pZwiaNeduU97X2Vf2WYwqletm8+CTD80zlFkTU68VzOCeZddgEx2LzTHH4FfTSdFb4ZamSjAc8YysXK+lcaRJExRt1CUSeJlS111ac1KTURKf2LGfKZJMUUvgtDDcCi9dmfDco7GUYg+OIayOcF0ko7YQGjJSNGVoKOEM768X0s0VrvBvsjVeFZMgMgoerdq3eCOTaeUoblPO8CKYkyig5uKKXO3o5i6nWBl8FmFWItW0oJ2g0CMvThLzM3IPm6nPLHMyr+CmpkjnZpkG62nNW9WikJDjHCoasxGb8gx1oivPneeXFZfa6fUV2VeHMOcYKBAxyaOoWMueDZyUl01ymK/Hlyb0FYxXKpFlqW+J2mZrG+/JyGxnFDcXYKFjW9ibU2/xlGPtbTOh7TEj1iJhWKDb3GTh6qib4HJe0VBeoOxf364lpi4LM/JfdE9lmFid8gwlaRIsFFftN5Ot0Q209lNODQoUZXRNJifHn3FzT+yiIfCYDiis8RfyVlMhbCvy0Bpu5SE1JyciZ9iUWaMs6V7gDVnO1mlvqOQcxuJZ6W6kVBBzn87nnzFZYSAVoVNccTAsVllSB99kHWTXGRhOF7Zy4BSoJcli6VPV5cqmIB9kLfCr0yAm8Ejwc+mjadajGBlsr+wcUlNupSysX5XmrahO1COdjuLXZajSVxYsyuDwzBndL9ab2Lel3a1RtLPnrS1e5Jrw7d/oo9wh4WKTbu9fnVNP7qArnONtFe0qsGqk7lGUirNgT6JbDAzi72dkjtJgWlVc8yelGYxwKjLSbJmY399wWS4hDEnyTaAfWrOnKxEY7hk33ucWW/jpEdsPFGOizgyXVBEgbl3aqtkslaBpExRlLluY1qbgatjpZJVlUQxaJCCdbF2lswl1Id5oFdodFR7aB/ZUnKClKtrQqEpKHLCSl+LRIU3Z3PWwniRk3ZXvktgv14nMI9KtVo5v6fJd0Kyho+YxXF/g5BRrqtYUmFLWk+hvm3YtES+nZ6CZL5wp5N9V1tuNGegnlUeOZl1OTlGgMKstZpJVkmwgCCXWEWUpXlZTESivmdXJIqodp0vXbU/ncGLzIkpwtNlsWBEQsmxcIDHiceVmL9dc0JXQs5RtI15vENEX2M4b7iLPJIxMW93TziAh9EudD5wqI120pdWpDNZxF+2p5iKc0TL1MyFTHtvxCw2gzrXkcQ/hFqFp8uoaGSb02Itij6ViHA9hoaMXI1purixash+kIy4qC2/fC51e5gxbaucGqMghW5iKLm/hL6ZK4GRQ9O+p26kwT0nP2yUMR6cgrPXMkN9abB1T0w6qqaYgcpYuqKve0fWsKRVlWxtXbxOjoxczyVdmocsVDWYss2jxouMio9egkhdUT+Qd5qDTKg9VMtMPot0t3YyjDWWrq+oKn+Fui2qwMN6hI2lwnm4h6lHkJByabKvpTs9Pd1sLaA7v7XJX06zQYtKKa8jUJdqZ2BrR4t8H5pkY6NTP2RqXiGOe0Y5aKg2mmSYipaAOtJBPjxjXUbFqVvYdmZAVYKcs6aO1NSSUL9CLYiWa3quj6diksxOgDp7GakRWo5xSs3DtGss1Jt9vkE4s7XSPGiNaTiPo8U0xn9GklKrTCWFnX66jH1kQGfKXJV/kFFfuMBJeGRQuVavwDbbdFNPa3KIt2DCXj+8mo5mdqvKVoeCM6Yon1dui58oiWdlZm5Z32qnr4iyKqZmf8qnhzh2VFtyvYo8bbqyaYiqY7uVO7q9I7yjt4jApaVispIzxZ1KbzdRstJsyUBgX6E+L5xwY0xNXMuaxctFqFhFxCuBjrhzU6rRb5gogVPZiMNKpnZiMNSvxnNHi7eGS5LFmlSmlmBebacrOYNejzh0r0Q/u0xnaJnMNo65TEpEUV6TMzRUYja7j4iCV43K2Elxc9m9E2AdPmZppyA1xJ1kxkhmo0uIr6qzU5DUyyGLwbRzb803drNSbWWEZkBgpVPdUbFzhm4rYdeMg6nIJYSxyGymVoVCfYqQmpiLMn1MUIbZZiq3xmaKi2iQUl3VKZN/tSc+hMKjW050falUmdSXXtN0sjiCY1Iz16I/dL0pmEy1zqqapjRpiXiYpU6jU2dnsEemU6xcy2ZLJKKCg02yNIXDxKtbKsFwvb9+mIblskrVtX2/XsqnzrKSnGGkk0GAh1bGc6FfuWa+Vncwj8l6e659VcWvrUeB1F+pt4xQnybWJ146eJo4hiCAdGdFg29hRUZykj+WRT9o2WpcdGW3fnAqa1GheMpNMm9i0z2BLkHLnmBVujNDnLmvlkOvZJZ7lnCPznurOD6f1m8/RTjFe8yGalRaqK+KaFDMVELMmTqzZDKAXFGNyHZAPprGWrZS1j6pN1BfwrewaElmWMt7wpy4epLSPDh5uLGyfXpXO7GC0GifbXa5rk2pZ0iolJiQWrJKt8BdeY1BJ4FGgJU3YD8lR3t5a9VGqns2tcORLIF+WpaGXsVBUGa5e2nOVmuvYjKUY3KuM6mxx7TMb5Rd3pYsOYWHcHtc2GLDRX/OPrJZla+lO7abqWYv0TrQsIHSbbJl1c+laygzzbQqncqCchoqpGHJQMSPMXorjbV4Z4m2QSi2eJBQZMuzKr9GfsuiQtJeukNMptGTKkY+UDkqt7Nrs3eGfHSaSlMrSnLG5MSKPFDPLr6sl1M5M0VucyyGTWOUQJhxk1J2PkyDS16NbDkxLWeUezCd05lwwo6NZml+Qb1WcEhe2apyVM6KP3a8Ub+5MYPfPFw8e5NBzIJyemNIPlp4zXWWlnemoU09jISJyqM3alWxOr23rF2GLjCS2UDdSYosJ0OpocaLKi+3fKSoJG6WWkKndnFuZjmxfkjGapRwz1a+oLS1ncZLVMdHa06xbrJIwqUzi5+sr2KmlrsxzC93xnUqkXXApSqhP3R7gTTLepZzLzRBwuDLjLmoLskre5xkNVYol1tVnK1HM5xIiFZRwle5XkAnoHBYr82lRDlMvKLLdrdqbDzGgoPHSrggq72uk56aklc9UbN+lYIucM9ri0i9r3mhXUbCbZZGqiowaJCVTWCVZ8E0xa+urmuJYNOWjLFTvD6eYCnRZlqzZnKnWnmjyE+8W5ZDlia+K44gWWqtGnZbnWB6Xa3DTGqXZqJpVoKUWzCyfU2eK3XJLaHDq7SxXV21UIDFY61uisVTrVKRQr51V2mURMlXWrRCnFBkk7pujoQ+W51WRVdjkbZdLRbJ1NGkRqFAWIlFVV3dMnjAqzxddW5Afb8ts8DT0EVk3JM8p5C33Ux5QaJicqanarS+p0V4uXpzHsRH2Z04p1pRpNKPgpyGMGOKbY5uMpKLZ7XQJtBAXl1SPZKZx9FsrbwrVn88kclJ2lSDOGhdmUKHvtOoK45fQr7HWMuiQmnJfS9gNapQM7gz1NZzhIF/Na2E17dlWYmupEFAnDiJgmIxsbFBQGSSdKNYq6eeXUR8o6ZYdkRbaU8+UaOtYL/Ja31/O01scM1+ltLdi3qUJLHLJntDbJHYX3tOyKBVgLogbaOguatZhjXJf5GQt7WZq5qeRGZCjT27VG6vIKBJuk+mO2KswiFtjYK7Ws2ouovNpz13rGJ4MymDabC4y2nGlXeJKUtzopbRuVtgl80/oZlozJFjvtmOstMxrsqvb3m0Np5vt1KGzmGPeqbVPU6USYVSOZujmW8tbaVanUbGm7hfi2RSkXY0PnGrjrZXvGRrYX60MXqBLsV6WZAwsKlSr4eFt487Mo8sszmIh7FxVcA/em6XXMFtsaUthYl+nYw7pFp/UH48P7rFVW/JhFV8abyaupvXsbhto62raECssoy0GbQinYPFYi1I2EelWS9D0TUlM9ClRkImXtOUTK1uSEZEjJaUUISPqaJsb5NreomGqpRg2HYw33ioVbFWgkaBZ7XHLjRVMKVSSMRzn1u8WzFAebK6nFW2S7p/drIyZ2R+RDx5nZJghVzhN2VArZqlfMyJWx2WP084d1kzpolsLjE4bNqT05u6acJJxpK7UoljykOvnCSQjMx+fnLQqEPKYFPZpqRKT4yZYbuR2XJLq2t/n1Fy0MeSN9eDeMuWTMmtml6TbH7atU5Pmst4SUewL0VGqz5IqjdQqlO0p6EsebWRtauGJIKTj5PKdHJAZI9k0W9loGaPzU04wCOHOklSUc44ptvXMD6Kf71hhG6xaq+/laNCX5hEfUZZPy63zm5kJq68SmWHXJxIzWatWH8sPKqTbGVsdiXDWW+VcztUs2l7lVdxtJpsZIGvR3WLhJ/BO8p7QFaDtpl9tpurQ43ArL5qQio5i2tsmr6TscM/vcWCTNRRS5+CVUyycUnYazlXrsmPnpJ+hpp2y4ZhjJY7nG5aeY5CttCPMDShYnKaq7UtRIDDv5eiLbY4icN7zLs0xmB3xVtvtlyQz0eWw3HNmMtlvMFFkUCtQlGIKpxwpJeUnGGcX8WicZdceEZPu2xOznMvYbRtnFarr4Nvv37AwkZgQJZtTHI7e0VyVoZfKLWsf51viarNhsCNV2FLVZGRmEKekbA9TGrFZn5bZUie45Nbeycop4bLoUjJMYDJvEOUN35AzWQyoriCVZBgJKDLmMl3cFFZvkNXo4fPTj2NhI9PqzyIrlKlc5EkOK5Xa8e14EFrY36BMDWbymASYCEnPJOZcMtqtm11obC+4kSO2nmId1VVQrrQwFl7ZD2qN8KJqrOokcFoX9uVRi01ii9uUnHFhlreLsZnrNWZYjtKxGhYd7Zchp1HwrqgUGyFH0mScaAsZFuJu0Cc17SMdUTEjlOpUG+4R8YtnXNHt9W8vKGhVETOI6m4flxeVLdXMaNNo5dTy72GptEwdLM4moCfOTRmQnFvn0ZqWzJ1al1CvLciYkxWR52qrzurds10Rza4yrlDinZxmmK2SWtdr1sxXsHIJbVZhss/u79vpRiruxeLGWClJrE/vG1LQ+K+bTpN07eMy8KaP7+6NnImLW2jypBQdJCMsYJMVVyBMapHyy2Lkac7W6dcol+FQFXdkbWNyVxyNjk0hUVdi5vHsnVYeE2KKy1TlpOJpMk2Qno7ckZH7I2KjDCZjWyJZ282xnw9PseWHbytdEWVipUzUHVxU3E1klE7nZjEdkRZQ3k8n2opfiuPwUtPXIKeoEc/vZuTXcLEanZ2SJqzbbI8N1V8InpF1lFSTqqJreCpfKx/kbosNCO2y6g32Lh1P1vcp9KEZ61wtok9jWi+UmvOdFqE3s5GmpxrNTlBq71BwHc6p19DazrBl3dvnirJrHtDl1hDXYeKpnOSrDSKQoMwmKR5qZt+TofVNUiZq8WQsIE60khMTcyYjWipp8RRg1F0pMaiNIjORMU8kpOPaYFgRL22d5Y4tqFmYWI3X4oykItTfGqtGnNAz1BPwF2icpeUQ4i9k7yIlYJJsKIitlmbmIsrlYuUZ8o2OtE/zy7RX4RKvsnImzdpnbUoglQm2sZ4P71RubQfVZ50U0tzW7dCS7xNbVVlSI6KtSUugXuHqEyZZmOkoDxgMtmdakWpLTGIpmJfmci507tpdWFno12XUrnGw0E6cmyObILOq0WhnG00MViHsGhap4eUgb5dZl1NcmViebBmwMF/ioo+nl63eIm5XF2srm0zSI4wwTdwPmNVXVpTrLFhmoIfoWqwpILIfSmIbNF5VtWYRnZ9T1SJhiuFpS1gg7GSwcG+IId8XG+iX7ZvM0V6spBzVKMtZX1AxDVkV8DCdnSB0cAtO4iYlHG+eji2fulQP4jUipFCVaZfP1SjXpqdvUx/mJkmy0UrwCUwZ0Dkw7lOp4lYH7EnoNQ5hzCeza3ANbFaa5XCQotdOs6tTFzYNKlQNLJbylO9JX6utoRuqkKWuneSQJKDaaUvUasluIRQlImXlmdwwNW6Ozh9gixbxnPCJImaWjRUp2t1lpgxMoBLrmSGemC2oZ06dNEyVsSNjFBJlbebzMR5Iaa9m0Cl19miQa6mVrG7aBuYwbioWtBrbSPDdatcgUvKccNGeU9twl5gwJCemY+lsVuQPLvHKIrQlJCAijdBRL9TTJhjNpt/WSnRoFV2PYGbeomfSpXKVI2OKyi70lYnecJkT6lNcJd7Lye8PienZ7LTPjC8SWVWplOFb1doZ0OTv6Joo1Sqfys0k0yVa058Q1G5HJqtvbnCWVGP1zuiPsdKkZKairEmyGquy2e5fXiZRXFNW3+Nf9SzWIXRwGnBoFCSrH2ddy9ltSeac54uV6Jwk6BhboGXgc8/qHlivM6SaoVBn2YqlKEuVTSu075Ry6JSc9hZ3atremRiYXc1gYypHMyRvqt6VG1w049aSokxjyizRDW5o7DJYEYp0FZxPn2Vz94wLU9G1mG730FCjpM1LceKcTGcjY6vPVNwaOKJXHw7U2O0RdKKtlvEaHxwxp7KcZO5covKaMJUPKKBPos0WcU0QeE2gEyXunOBsVI6m7OpfzqGa5F2rruwTHKsjlzOepC3cbV9kpeJisaBoIaEdjBAXWXNNXFXu6GRacQ3wSksmkCJs6VIUlg/TqKskGpiiqi3ellqmISZWKK1nLeGuXGGtXZBfUlNoLmMfo85lDxDaN04ymCnw7+ZH8DHVM1TcVF2YrXPv69SZV7QWqJuTod1mFTFcE45yygqrSWyezFBbjKcY0SwgMDWVVd2a2ZcFq5lXLV+Oa93T47GYcOxil0tuolgebBKtnWKR5qxpytPhoerl05KnONBtV6QeK9bhzjXQnM/y0yFzmtzwEzJbGKMOYk3tSBTlLpxgEdUYMU7lljJRMaNuqeFLpmruXReSI9MPtqfijZav25UozNWzXy3bKt612CkRkh62Vurd4+Rv8VQo6RniM5TmUASlrOHsJenWTvKa11vrldBymSquqWpNseJNMMnm1xExNJLk9FQfjCqaSiNb7+EuZ2HinBMSLikW72yXTTXXS6TRVtdX0Vt2mSQxnC2gjkpg3+1Yk1ryi9Hya0wwIWzVqqxqp6Rqc6Rdj82meA948dISXWzxCKWxSYtx3eWcUp8W6R7r7RLfna0iJScODM+3tJhStTBXJs2InK9TJakT0UxWDjrl3quyTuLs4OtK2ShczvIrXzPpakjZ5edVXEwRoLOxk15qUa3dEqmbog+eUHPnWLEWXC6SSuEQpdTPIOS1JdWYd3KNzmwxqkYaKjTUlnGqzhLrpUkTNs30T+fZY2zwFaCR83Eh8hfiHKBelmVybWuTmRTiluSY60rNS6SPNkpdn92RYSdgTNLOI+RqkxEuKl9SqvHzqthvjLBtYiHL7iCf6ZthKWleDy/JY9aUpGOiHhJncLjRN9HhnBgqSnNvo58dCqjiLeBMMd8hsE8sLa9SYKveEy4T1HNz3kckWqAyc4/N7+BrT2DnoF8UGdgyrdIyE6NfjLCNEqUh51FZTqBVKCZWbTIxVTIfKtKpqmCJWfW01iVJlqbalPAQZg9lnibk22pLadAjEKiSbepkSg3p1A23tK7NbqPX3NrtaHabDQrkFU0u3tw1KE62kU9yIzOilVhNLCkvk9Od9ZnoBWtKorDbNWaPTK9zGWKdJR/inUfu0qOPGhDQlqrcMK3rzKNoFU2oD/FrUu8tbRULIdnuMGgorVMtzZ+h7CgT1/Qm81bZqCdtWJ+bWNEOau4zTZ+MI9Nb4lOPzhxXj/Dpm6FI0COrDCOq4SlPqS9VFzGhE6oUrcskK85msd4IThrYNrRM2hTVWmmSqNwKJzd2ZGsRdFQLH6HjNIlpp6tbp6ZT3KDvJ1QPqPCrD5WMUlefm/PUmEdvE6bGzmxdsxmtbs+WLh8o7SCbEBQvm+1fTx2kcbDOy9RsbODnqSXOK9xzHFsbDhF0D8qhptdm2tL2o3BUk63rLikVI9aoTqrWUK2KLBKdc1NdrFZn5OsPpal3qaRkGszXaS0y7YrV2fRiiycZLdVo2JB1NRKclGITD93RoMv0ppZYzSErGc1eFyvrD8/0bhJs7lMOLofvJxvashad31LQpKPT2+HTljliYJfy19opDeIsdiVVF+AL84iJoe8vDuwQaeXWm46aFDEOl+eICWBQ8JSvWhtTnA+b7VrSmqdJYdhetBxlHE0zC/foqCwh1SFVpOIwsCTXUmZsGuVOlYwUqKgncGVlcpXyb1qbJSCUyTTm7dlYcZ2vKY8bLN32texLUpXN4ZGlZOxP9BZsJedX19sQK2XNHuB5IZOVYA/i1xrtYiGLV2mkJeLXEhFipknbmrYSWiajWnVibSaeJ9TQ4DbXKKsr8dDK2tPnlkwcJyWKdZoNIavxsEqvDRKiY/Qt1RPliyWMnDBtCjDwaNmospAnVhxtbWwtzeVQ4BkkFwyy0h2ynRPoj+2HrWmM5OaU3i6dFeeuDqXsqKWo60yzmA1Xk9UcEVdXZ/MuDOzeDiRzaBTqbt8V1RBiVvoQIirYV2SL7eZX9Knl8t+u11ZrEuFRo+PyjvCQKWms0tcgV+KL76rlZrKYI2hLnfXZ7Ywg7eKr71yNL6asKy2LIlixaODFbh7QWt6e1O3mLVUMJvMV41pdqm7az7DtWWAS25+zVeq3ZSdMZjGSqFUdJxXSCbNv8lUP1RJVEmVNaIxccuNpljQL4evRz7MdE2PIa6cuzFjiVp3Pmp+oMlhuT1DvMiLhll7Tnaug3xMGDmm1ZdNpa6igmlBL71trDagZMZClpOK+KpYZeZajldFu2Wfy2pDlyJaYzw3MIFRXKRtoJ1LRjp1to2LP1c4eIVlk8IubHA+vWvWxLtIeW+5hXaHTqIthC3QpD42Ua+K21522GZIM9OcZUVwmmhAP8BOk8t+SJy8m4PLeEuj3I69VMRqbp9EcUxabsObopVBMbqHznLDZ4FHSqlApMlWMFEueG+NvWjAlDXMQIXloHrGNmqpaLhUNWjHca1eoWmwhagbkKSyfnopVlo8NjekTVpwjrKbK3nPS4PFmF1GfazPJsGUuVxShrmbqTJRiD+BSdF8Po1nYX+vJnhlY4O9JchF3nqTiYBNoKhud6vQg5Laro0+iaKTUmWv0MV1zVGgjyU2L69pPdKJQXKbgSdH0cBEtH9AS7e5dF3DqbGzmktjcoFFWV/MmX+Po1V/dWiW00U8ocM32IdURppEZWMwllItjLKAP5aAM61CjN29ppJEyGhBQcMfhmRdmazZfHbRdzp6QHunkixR1CNfk3CKRWUuo3S+sG1MUrXFMlmNaIyHwi9hMoNHNLhUWUhsbHE7WcpRrIVrRq1HbKB1Z79HuI1cnsRxSrSRJ22kvniQvamUeYBdvX93tcBEU9hf31zfaW1Wmj66rpuwQdN1e3ScX3V+d4i7elFBOVk800XANKmKZUpoHpuqhlWona1PgoSGzrt4aVLWSpuKUoNqR3ewx01fi9rYib1/UMNSNdmk2b9Mc2++c6bGpFa1bKtDSaGukKtCr32izEdAiXjBNXhFey+er8Ghs47JmiCZqTPGZ9tErchsM0JWLTeQSDjEkpzHaqZkrWLbKcsuXps9X2Vmfq2YNbm8KkXJMT5OOGfFT1cyRY5b1ppDZNSZ7XeKuzySZlx+tlWzV2mtkERxb4WEVF5VXq29LhiMHVA2az2hg56OQLU2MtZlbDB9tcBc1EVevYRUyLB+VGBZNpBwltctKV6ENjWZloZzwjCpozt6k0SsaGh/Ho6phyJjpbFClM2cYEouRTg2dnZJQSpjiMI5LkmnRYW7jz25gTqDPFuLxK1zyl41g7ljbVson8WkPp11pTG/mnuO5KXOPISgT8RlXJPIeJ43PklKyKOjUphhakPWjGQx13xng5Jut0DbLYxDea104I88nsEz048oWjRCymNymoxuzipRSG+UMGI0gL5LflgwT8POz0FEoYZzW32BXqJpTW2rnEuCc3m8NUxZkWd+pH2jdG9RX3Nenkm0yUs8p9XWTMCedDJ+XT3KkmxpXlacqD2TsjFAUJ3SmblmL4BYaJ5kQ0BFy15dol9mU2i8skbQrMZBW3e+mq+OtMJxoZ4+nkottG6EX6yAv7xuRiycyBmAVLVHgZxHQju4NKmsW9M0OnllnnZPdlNh1JQzV2zLUD8qJV2pY7BMzdAxv8XQJWgkWkm+2dmI1ZultFizvFw8vJt/4j+uRZ2HQ1mQxVuTPBt8cINiiY2jgh+kPn2ja1K9PmqMxtOZNKWsa2OVV5eQyDFQYC/NQ7xDaUdS2YZEZbeX3U9kmLc+Yr+gcJ7IVDspn5bcijueXY+tv8luKlHLis5uJksnSpGAs6KDQW3PN8xEuFFt0Ji7tUejeMaqLqmnnkp12GayaMIpe8hqqWx6LE7T3N80OaQvaGtefamlhY+Wj70+RIR7X1mml2uKj2+Yo2igUmC+v4MpukOiQje6lUaeQMHEqEIozlWjjH2tjXa3ZbjAecFZGzt5WJJTb8zj1JdVyKNjVZctTFi4aVRRPblhP4x/ckmtZ5hZW4Jofc3Fx108sW86ySyBhr8ye7xfdGqoT1JnfbiUas+oTWFsNVKIpYtyp1yWz2NDPXpxnap9osedfrFNhnXpZ6aXkWixIpRrl1qcpi6KJNVMpmZ+iFmmy5GZrJ7Wsj52urppobHC16CxuntZqjZJ14o6VD6Esyy4dDxkxYJffXK0O4xRYpojwnhseq0cfYBXNUxRVYpcl28svsevR57kQ3eLUCEfx4nPxyBEfIXIaDzBVlTIvlugN4N3iIRvgNdCtIawnry3mhCzkj2qPqOhK7hQmK9qjUFLR1vWhGZjoUZyaGGXm0SrN6q7bbpMQZ7RcCyfRoI+yG5jQ5ZNtkV4jy+nvLkhcFabgz9bd9GesS6ccIyYNYhpxIa+K7iTjjp8TbtfsVGxq7xbc35CwE5zM6SxcZo70L6Tei2GZGCWQoBmPUFHd4fe4WJXXpm5kEA5wE+ZfsCcLFoxRZB2tTShvEV1t5LHUcWZynnFOypXTJ5GcJ6bpbmUwo6KNYHI1cUzWnuxj8CRmyKfqZZwUoFLflggnGZjzspAVk5sltFbvzquubSyqVQzOeF+u4jWUESZYospZ7Y5ol9rW6jCqEdIQXB+pH7DdL0qjbrIRi6XrqGwpmagpzRGoyvHu2Guvl8XlqJ1cMw+VKePK8WFbWp1daW2aD0+z1RXqY7KTslDyayLiGm7eUlLa3uMr25JdU9hd3ZmrLwmvsFHlqmGoa25eFCGhUqOllXYeHdc0J7MKZu5dEyi2Ytfa4+vrjRQM1OGlS7UdExJTVHGO3eYqLPNYUqu4oN3VmM2kilvg+BwNB+LNYupuj12l2eSuKyOyZk0SLhHV7ZowEskUnmssi5I0o+NkcvAKaaKS6OExVMfybdnNJ+ulrJj0DQ4XrRFTE7lYInNjEKmFl5JrJ7IkHQ7K4fEgYrGhGdTj6NIzLw7ZMSkg14luSSMtIOCsKeWgFqRp6ZcN5vFY4i2hHZF3pIxza6kwWNYbKi/d0LCdpiSLZG2tzxE4FZ/tHYvN2VNV2XNosQdpk/XQHN5jo1OWGbCbsFZicFjgJ5NmrM7tx0gutdYTEI6WMCrvjZ/c0BJwslcUyhuXzW9zZ0rXjinwWShgnoqUXrPn3Odb99VlW+6xWVdMVdwPsajSGx5o1tHKcM6V3+lP5I7e2tbs7lzmZd7mspVu5+CK22LcYxlllFEXppxdTuVcXNKj55r4a0zzMS8WMJaUJZ202W7QJ1AkdVm0qSLZVg8b1yJmZ4/REC1wnbBkXFlqWerxzW/tGFKJKfRddebaG61tJ6qVa10UGY2e5A9e4ZvfKq9LKdzNY2plMpnWE14oLQ5a31qSHZLjHfOyWRXnHxmnHiHsME8e1BHcsSAjy4xMsiG4zdvr708yUg5rbmXilC9lIeknmQzkCYwb69JkYR+o4tUUyvJLJQ0Ta+uNFtcZmDEQLZjy1Baa8ddkMKTqGE8k8bcnJp/WJJ/jmRaXrxJ50Vyo0AzZLTOsjqsGRqNxLckrVEillzJpCeDRrJHpTx4OKl3p6Q+laIfoEprwS63naCJdYS/JWyhgoLCfeJw2bBmjjJ3k56hX29zgoZPZ69qrrEYsB92Z2xcMXNmU6KAnmVDtEJdYso9hsaMnoNLtC6Lw1iItozCPTOkQDnLOjemQNPFbkUzukEwX0Y8PkHFlpt0SoWwIypaz2l+oE41c6SEurQ90peFOG+9r2uJn7JIzHlgpGacS2i+f7muZHB/js0jqo+/wB6wrUSu1VZ3dbd1O7NsVsavq0u8z0RIXU5fqFagwMXTx9Jdr4Zbyc5MiTaQRobWqqFNqJ6YO4KbUpBONsWVejzLzDGlj7vEhI46Zk2FpJmpvF2TPb9Hw2xEw2u4kSLLhVs5qoJDIaVIpr+dZ7M9eH2UVko2ervMaVk8Uz630UKT4FClUGcrT8SdkSdT2ja0yC0XqbG2wF7JjK54R5mwMcOdiVCv0zOafr4kfoSys3FYpFF+ioNbeIhRsGhBfXsvtXOYx8dBjEpDfXK4VLi+2zosrm11m8afOsJVUXFJdUS/i1J3M5+6niuYvdZfP0E6xY+tbbUpfXAgkW91m0pOXIhN0qOTpKuVZIfCVCtWV4B2rrtjr3eZY4vNSWOVatFLd5dZpCXKis12Wa1xWaV2dns1kKtPWmVqU8iVj3K1n6NdUD25elKir68eapR8kKoos6oVonS6r0Zgo3y0rp+FqZWZn7cWnjHBdowycmGLmax2uqualNE7g9g5eWQotKvWNXhEaGJdnMBWebkdey1Yq1zMzpumIpihdlG1wrtxzEhZT10xs69XUi2kPXoiIGykjXIrk4F0nFiJfbytpYM8a5/aurS8XpLKg5izyoWcPHPJcnVBWolLPY2xrkTFiSiMhaGiMUksLFPTdc1lO8I1mrlwKHPHpiyCgidDK7uWO5A5lTLRfnaDPZKvoGyWMXaYlokvfnTNeCrMkJ+BVch5Z3dFbLkcrZ0ut0pqbKw1PXmNMEBSnN9ZqM7DvHLYk5ygaXKAHCnGv48Slskht3+pgMI3TC6MXVGhPNS2catJYMuIhGCEipGwSalJR3d+LEKCRZ7CY6NRRMBJpkyEcVeJuMY3flRdrEmvrqWAj1JxjE/HoahXqpEWfTxYmkWac8mfb0m9OFHNOppHNpChdZ4nQD82hYi1oDKPeV2OT6bUkj9fNHOSb3RRol47VZOQhTvJMKOdOb9zm1g0fMB2eKSWgIJMQGW4eJPDTDvDwzrgVEjIyYiilnuNrp0miUnPaTK+iEK2omRncHq0orTFaYq3YMCPRoRcw2Ekdr6Ibr5mT21mM2Sgqh9UUaS8ecFAWnONZCwXp8PG2mBUUFKEkX6Isjt+oWvHgWVOLcBepKpQV8OeJLuMP2+IllnAvU2sirE0hXaneIGVc2uLt1iStaw+MTA0ryuPbWxTqGyimX6guXRtyJRNglNhvpxGkWN7iLBdMkKNfM2ILmZ0vrV0m6612ZScMtlaQV7OkriSLrlyuI3FwJ54YSzSs7issc9ogE+1tVbQKHLMMjupiTl8ijm4mFHLzi1/hMXSdqc4s6RxREmeu3qIUypaMHxBQLmKkJmRd5uFhSdFvnAt0auBfNFR0oK5XWxIXJuGa4smsMjDrElgX6J8VVqhhYhsg58rO76HdRxAv4W+qiKhhmh/2M09U8OlysZrl0os2U29KLo3wkenq2lTM6ZXPCaLP0RaV557ar5Ts0qFPc2CK2RrcZKhul81bVJH0bl9jklph7epzCtmv0VFSWeAw2/ScptkTHQwzGlmZ0y9codycY2hllyQUSdfqHFrWqwYtGthyYtAcKo0QIMtYpWrPiNxOmd0v2rPz8Bue4s+d1OWQ1DCR2bRW29tycSjzEKYNtWtjqV9PXW4ozV9ZokhcVOXvK1QZFd4TYZQmkKnwmODNbOVQtIqVbrEfUlbyVdSQl6rs0g5lpo/jMlLUGZoeKMfILxbzJ2VeT9wZ7pMtc1jiVe/ULGKq2q7vtKyNapDHME8zilcqpmiGpKwpzI507Rhg1pdUZZ2VGWJRpHHf2O3PTSEObdToFGKeovHtqijlz/AoT+5MGgqiG+ZvimcPYlQflqQo3d/p51ziV1xyC1BmHtbMbWdOEQ21NjLkrV4On+8Z7+5a5Swx0SddWGwwzVWv3dYM54ryZNJQH6IjkDHrEEqdrZ+t3AzZZihRrRIbJxdH1VnknhONqjGbMqOg9E1RzmyWmQ5oaYrxbhgnc6Fg5ErTkFUeL7IWtTElsA7jC9Bu6haqzCqxjRCnXiuh3Nuv00tLH6i2VpkrZfMNX+C2Dp6ozmROF+dxIlixUZ6kqGwXy6duWeLVmCNcnKPfFk100VWQV1GlShhXJlob9hJPFWhTpq/kROxsconmnapZb+/Sp23mLKzK2jOd39UZqNJxilUOSyPRV6/zt1VYrmUyIB1MJqmVY+QuofIebSQtFPqeyavkYa7XrRbSGq0t1Ntv2R+03lSqYvFR7ReMWmLjHBwOKWkI6rQq7yhoY2zLMS+pyKDYrd7iF62VHdxdZmjlI5COCu5YmA+Q+CqSuJaLW13MK/fxoVDTHGKmaSvnNt1P0OwUMlU3oVwaXM+n7/AOYpPbFTOJSZStGc0mrpxVm7GrXlskUmymqo6aHq3pHohF1ijOj5+1LqyMbuWIYO/WWSyPGyokDVAoouvujRxuYFuT26Jp1ujX6ukcDxC4D6kvzfBSdxUot6WaEZi6IRYbIJmkJ97J1JWcbq/e3gfNaEyxa2HObtpOpq5uIWLgLuQNllfVG17jYKOsHmjazRFJcs3gzlqu8BNN7Awo8cjXtCBSVJAp1GAU6RRqyE6SWUotEsgfixfzSTTqpxt1btIqbepOXecWUlEZJu4fK8chpl4okF2W0uweiyahI85srNXjZaLfIcsgz2HP5dklplKgK6rWHCGnHBep4GUisWVKJPSmGmWmSxpW2C3h9CcNFdkkZ5kuK8pL06jiJ6GfZlhaktblrFpgnAznJ93u3a1dGKPwLoXboCmeY2yzoiaqEmGcz01ocq/XnxMYLJaRVybfmQmPSstqJJYwZeisbDAtnsxkaklNEkyo8Det6xxrltYh1i6vptzjno/S9evKjNavyKDgI1xhMJ/11lwX39hT6NDpHLRclpJUIlfZGvJRClvxzexWHaKmKiVb63Fk1C0KXvPSXxegyS2SDh8t22PtVqnhceOfaNFe6asaaJuqHOfr8GJnrJYY4WOcY98TUm/vbY91Tm/T9BUzJPIOEJStoOKpKtjd7imjkbYhm8in0a4cSzGsJ2NvWDGem3IZIwu1UxAvIK6VZYrUbNPzn+9t3Oio7p8tpkwJbQmgK1Gyj+BKWbRty+3ZSlpusYyaaZ8sB52rJqmo2ixfTiwLse7t5V6ay+KvaVOV5tl25i1Obl1e12Ic805hTCWrUmxWnq4aV44hCyCWIGhXE84xlahYyNxasWqpYOidyFOsq/E0nJdlZQ6xdDQc4hqi0yGpYZH3tFepNw5313Ls7xFp4tm0UCXbHRBgoKNn2dWdi09gzDMu7xOjVm2RqmAorBcK1KOiiuZSM9lVV1dltV6NzpQadbXPZyLr9wslCeZy2FHSVRcx5CkSk85Xb1ksnm3b5WEy1pLR768c519fc+1Ji6FR6VitqEmUjl7XrbLQmK0jzpD3ziyc1Y7koNOv0bRVz55G4aEhGJWeWBMm1tMRT80mLBIrNmgPaVlhhrGtK2kwn9reqS0sXMhbkSTN7tzbyhwScmWqZMuOph6SXxlNJxlWX2mw1nVPcA6V8B8frmFOqGWuC1aijJ2vTqzlls4kKl1XlLPPZV9SbZ6TILGVmqekEJacZ2XdlLNQEB4OY66XrudQcSGKKqRwkI+xas8t2+4G3VmaShkfLmeMaGerzLRw2amUlLJzqieWExHq9Zb1aWxgSx5Qkt/g5Y5d6Uoan+FX2BeN8ufrqc5uznaJ7NOeEUrNcA9wFaUtDk0XbOaltZesI2xjj/BzJhYxyQlt1CBGaZ5HVuEQ0XPj0WlKshZH4lDRLDBeHTYRTikWIdiMaLBvoSZWSeeMqqgmIRjWTtOsKJFW0i8tF9zRpDHfk4zsdhcjrYs2k7PbdU5jEy9NCNgtch+pdqJmpd+uzpFkc2tZ4zLiIqeeq9sSm7WKXtDsUJgt7KYTTiOVT+GKcBbrD6fuk5+clCbM5uHq7FxsXXCWr2FLX95x3iEXI3CPDi4hNA4UU89MMNER1JL1twcE64ib3Hm3OdETDtjNHzHPUptW4fFSGfXgmF8q82rTliYfnjBhy+hopHBtRqkMEqVWH/RcXFZXXVKIXVQN3B0qrCkuMevxCPNIITSo8XNWXAsYT65XpShvrljtkF1xT1vnrFEy7GEbXu7l2etjKiXcLupP9m6bMyBoXhQa1iNTtNUuHIknKiaw13Ay23BlZJbniLGsVytbJXKc0DGJruUzJJ1tLcollOuwzZzZaReX1evyztaa8gpU23BMj2WRI5DepjJqjSXUIyNzN5fg6y2Ur7EPm+lknwkXjWk0ExhdmydjkPFQIWkQIFtok6eQN5ChnFrV3WTLXbBiqizmr24PzG1OH1Xn4h8tSaAe5suRziBhn1tOpdn6nxSbUS1esx5c5WhhjjSpi1BwZvCe1GhaMK+ebV5uGYssS2aWn5Kj6wuhnuYPEmEgjXIiGBmd23KwCGEu4NwxVmKsZKFZZc3hKClHmQyk7KYfFVqyrGpSF6uu1FSxzi2QFuVgId6hCyTK2hzbs7Ab0ZeuUNhrD17VIZ5V6+5YpO2SpQ5mHedJYOKqS5sg5xQh0m7XTksmHNWpqCzdKEfFXWcaZ8hKXEzrYmkzqe1fVTMN1ptSLVOlVlVslRMTVVg61qBhphfYmZ6gpnHn6KlT4pywSjBca3F0p1jtTCllk3LVuO1SL6vmIu+rKRhV0qXkeqIxoidkb13bXRyajV53E1pdSpZu5RCRKR3ZdKqYcBnMFV/UJ1MzHLYToFMf4iwKcaiwmXMxmtO1nI1g8AnTMnGMJ4gXka7f4mGSN7Na8OyRXd2h47PnkFOvynPrm2ocI6MhKV3P0upVZuNM8skVzanqbKEIrGTd1w4h7y+t8yWb7xZPo02Lm6AXGGxdE2RyWx8RKC/PSx5Lk+/t5WSvOR/qkXSXyu3Pcq6s3+cyK+Uv8fTpF5aWkhDwjVsd6OOQTF0iVRlgZa8RbVCpWHNb36hystgWl+foJaXR5rEdEmxSc16kbp9YI0wuB+vuHmyZXVFIoJLnHsXOYKSs77AS5otI0mtRMdPbHIxlXqZUjhH0dF1gkh1mts+YXHVRUlRtVKqUH2gTpk3w2/CO1jEjrM4UjKlxHGlesZ/XsZARcwvuS65tUTNdTmIv4mftnKew855rZpMVILNy7OFtBHFvWx2QFs5lF+LTZ5blWCMWJK40s8hq8fMKKRyvpefmI5QjahUS6U5UULGmJ6LfKA+l821sW7YUYxO3OBkS1u1p3VVRjRlsuG4dpQw00wlssRHkJyukWytyl7Z2nwvR0zVWTc2sbzLKcOCO129eKNJXYxHtSZtXGA2oUtxRYE2xtR0uUehuDB0P1NEZETfTpdTqXCthdaVfU61fJWPyUTCjJhbfi4jxYStjk7NnsbEPymZw4Mhx3FoyzGVb1U9dblVu03BsCNrjKlkzcVtNoFhZyqSyqK4lVhXhm13TbxTmV8doHmcyRk2Lom0ft5gNYNAMcA9OVm0dycscWjGey07NIt/yC89gG9UjqEwwIzDKcJepb6zpU/Aezm+TGZhhC23THJSdi3XR5Glo39ruHaeNJOOb5O+vbREb3mvwhYlSy1RSEaN1WO9J1xRZTlGnr8zgkpcSkyZMLC4d6eauFlygWudwNVx3WI1V7liQpuyn4gqzTyTUHI8Tqg8oYadk1F20bNNyJx5SEClhNSpNqFvmZ1pX2UwTaypLCuUjR9AkINpamrOxb+i2XRPyT+0QotIU7QyaLlQhFqT1UhUiWaPiV6MQTFhKaM8iqSYmFdlg9InuM4xyKWVxHUqO6peVZ2AMynEkGGZSbOsP4stc3OXe7MeZnVSgrulXsG4mXi1gmR5vq8rzYO3ZUhsobexVDE0t4hoVWoykiTMZ4LQOWppRU1ma5S5nXKaLquHoiF9mb4vQY8oczFnKi5JfdCRk9tNoKc7b7+PMoxnbH+pkVmJM2LKfGbPf0tHaUeskz5Xa55Di4eYqIZnRbG+ZscmN4dNzGOtayJbumd0x6I7s5pmuq8rVytn0IO9QoW6klEtYL/NNKVBjcJ7WDk7HY+iPqDIuEwwM6e9qjqWykt6QGxhp5GqLKOqvJxhKM19f5lKPdh+x3EqxUHHYXBppZtyY5u6b2HHlymodUwu2d1JMKqMU5lgocm+pG6euiN/dtuLN4KvWa67jbtwXUhYz0FpmIeGx7+tele3loaodXzOuqu/TVNSXFgjds51LKGug1KItmhYbYkvUXe1J0/NnX5rOpSdMl7AuVqJaESevo1BtcErZppiTEtrgzC8JrC4jZWFMZm0pUt/UGSxinGLf8IkXcyRV2anjliRJpmJl202nmQmi55VpaY2sWvCc8E1ap1QiWo/dlauTzc9drWKXKGRvqZkVH+xgCttjo19u7wxUpYuOrmKVTlrmVCskj3CQYO724l3xTdYu4kuSnxrt6VMpo5ZbWjPLz90upJPO4zLpVG+kY7MSUx1Vyh5ayvGYcZ/Y2iDxM66d0FJhI1Vq79uZB+lUpJFLFE3Pz3dcdI+Y8UnK7VjgkfPSlOFvKSnZHAza7tArFVCbyzTbs/eMViRlLeEvtdRLp+pZWAonzyqRy66FFChKoi9o2+kPNOBlbdlQJRqxcaamIZ81U9GfkNIoMsunKlIknNkdpdPXafFSlPCsUbfjqxd1aRjqy++g6e7i7Z/zWk/krZ4tnvErVc0MjjIjKLHz2Sypa45Mn9jt3PBM8CRYktqW9U6m3uFo3nHapdNOW9vQF97vFOyllhdujKqUcNzRLDNjrVpdDqhPM16fFnMLVbeaD5TK1ZTikvB1alnPj2EoomblH5HVs1xYMNVxnynLaxAgHCZKWKvYDviyE+uQJBgf6CznLVCj4tcuqAoRkBLQXTAmzzDVy41YkszxWbMKl9xwZ1ng0FzW07E5DZU07WWXtNkgluKjVta0SZBnLBcXj05c62tuoOHjY/GvrRqtr1ytrkjOsSOu75GhN2VPklHYZy8ts80Xk1+Lax2ZXZYVkGWNbaCxDjYRGh9xUp7ZmyRo2SGnUFaqKZELtg03jhOoN1PaIl1QahRs4HaMXeszy+9p71gyHebr0a0imFqa6nPrD19sHJai8DMToPBu8rDlWKj2VhFSWah3dmjplZ9jtusqECfcVA4hXUxwEFqw8msnCeGvaDQNcxyh5JXhcIkVZQ/VJ+XVYU4KLZ2wpB+1nlYV8OCfaOyfl0upMCMi1aDn8suTmQ6pdlso6XGyiowU6KDl6Ha5jdEmoHCO53ifNHMZFrExsixJbdvasYimYRo0qCdvMdXWYtgnkfQY4Rl1rtwfEqmPZmHtHQquHV+YM9wX2+ltEvDi5tpbliIYmzUb0qedadPXqa8XkrUsmg+p3A1R1uOkHlvMHx0QpExiq83dJhgSXRtpM2/cDgwVEFYXG1QvHBVOcbevj0vt7+1R7V8UUxF1npZk6M1vM89PSVMqKCJtYOzi4xHgZ2NL8lGwFeKMbUjzjFFQHyFs2pQa1AwWmpGlpG/fkVGc7w/aKLQn6rJbrmwi1wzMUGTnilYo6XNh1lfwF3SHTnIs4WYtTa8ULwnoj9Cq3DaQUe/Wohdk906ukNIOzy8OJxwboZDt4xfwFRIqJFAXsGkPhyZqbR0PEqSOsZBll6fhSU+eqZ+ioJivmhXjEtVKmTmSKh6hYC0wYLM0bd7OKNhmLd+zr5xhKRTP2rUj6CTfTxPw5ywPcGgZbiSkmFtcbys2peGsnhlSF01s5avRsJxvkdmSYO3MDs7otWZ1X6GrECnak1cqLZjO99WryfOXEAdRUBtiXpMab+uSmJrSY3DY7hgw01RRWWotUNoas1Ae156lpvCLsA1MLswd3ZddapTWTRwpaV7y8KLx8xkQFmdts5yVDvnPTN0TcgpaZqDw9ZbNE1oo5itzqthSUw6m4l/zzFoq4BjNj00QDF8hE5vbkE9Wm/YPpCdladHgn1XuY1Nrs7Js3FIOoDdSEBxOC9XY6ZRVGHCVqd6jq5fXK+1KFd5vpnENrBDSV9fQaqTVTeclcg3dLeSiiBfrKVKUcGT0U2PtNS4PMhPgL54eYNLnL6IWTxnmV1KytAqWVSNgpzJlkKvfrfBUydoTzFPf7vLVLTFbWOHTLWNSEmzLsGgTiNZqy6ntYS0JmdDOchypDbSdat+uNCLeqGaWb7NsHyGQI+trzNQvXW8YDxTQ25zd7+fKiEzNWpziqeUsWJaozCgJ7Ql0ijcfcJP16iWc1xgfESdtG8jdnliWjhS8GKAtZ2QZ4RvdNbRdt1sa2a6Snt0lz+1kdq+poNge3zC0ICBnCPCVZe5K59IoD4lPs8/XHqjxoe6jbtDLVGCO7JlPdC7r3B8P3FELM1UOqidP3po52pOiykpZ42QY8c3ey5CwLbHfYw1i385jnF2kFFQ3DSDZCl0j3u/eoArqlvCbCm9VcrD1M+pkYFFcotzTUaPjbJBiHKAWkuYfGhNnoJ/i2vWR37Sulkm0Ik9oMUzacuespLBQE/Aop2Jm0PAQ6aXZU8np2O6L6rHUUCtYW+DjbU7oSqitrSKeDU1yVifObt6oEJSX5N/eEhQPEhegDmCTEY+lK2BcUayXb9kT7OVw8m4ooKcHqxQfmotU2CIplZvi1zR22dUZJOQMVK5qZiTZ7lKHWA/JDzBw1FGTlGolshucZJQWl1jxkG4mXQ7qqRLtznHz6RLaHXKrXnEQ3BseDF9S6EySXKRgUSNhS+4THmLlFw/s3d+np1coSWQcYkfJGeps56/nGC3Zo1tl0uXuMonosiJWHFvtYhjQadtgXqGSbBzS2NQq3PFwCWTqyqIo4Jjaa90ZKGjoE8+oH2ubiVWrnKeSJ8mZlV+mcs/bDDTdIfBnM1PlrOSPsZWwpLCrGw1zmygJECqlXV4eXzauZVSyyiruI43MnRetZ4ikIC1lCqqX6LIiqlokE7TT55Js4Agdp3OVbXPgoJVS2ikzTFCw3BabJlpPaylTWSRalTSNHLNpKVibkubT9PDx2qhMZF9mCCbV9Vi2i2NZl23xVZUqEyzLFONjI+IeFRibGdRpDaiobaBt1t6ZrVqe66rxzRKXbq+Wj+8LI+7Q0a9WS+TwWJPuzLNMbuQQEZITy7GVMMvdkKUo0jKVrZ5k1/l2E1JdMx8aWq7q3heNq7Adj27fZVcSMNcsH9pyCg0Uo4vXlK8KLqmdI9oPGCkgFJ+xpB6i1vReCo8q8B0wqChJ2/MwaWzPyjFaRw3Xq+/PsSrmZlixrLAq09Ri4PIY5rVsaqOTm8ieJqkR3m7MLAwXKxpgCBRgMSnx8zJj8tP4N1Vt012SeNthG9kJHmfkpaxbXudV5yKL8VSqIZC026kfVubmkF4fqeNq5WhIF+DtSurcVWLbX8wPqxLWKdDsaxpyp1TdT91lyvHrVRywm5AiDg9kuRClKKsNW5lgraciKp0jsOaeIaYboa8vydeh6c0J2Z+X4mvU8WJb7Vkg2CU0kqpJWBZRm/fTsKZu5FRbTauZDGuhLcFj35qqyzLUWV+eYtPjI6sxq+FpHFeP5eV3YRieqeVXMlWjHw4qbq4imw6LFO3zImQjUXTIUt2m9B+l4KUfSzDMaRWeyh2VsCHgs22l1urzVPXba2ap4O/bjzPTGstyoopyTyf0bFhu4TAxVlnq5hQpj10d2KZrb3CMzfXcU1EmOR3h47FYkdRoF2KV4ukT5xUvEzFSH6SyHijzHK5SUR7PGVhibN/UpOiqm5UpliBt0vCnbihck0nnreOXrV4NlB2nVeVq8CdNdZZw62Co0G+h5lLkUSLjGjMuLqDPZ0nd4tLwqNStEtJRGdovj2IQ6JrjTx9M4J5Kj6GcHWCRMFYSVt6krqjLCmmbc1ojqUwqHtngkbNjG62a7MlyUHDQW2+woWFuzyupy6dj4gsP75PWIS+mq6TaYGvvl2HqBs9cp+lN5e8mZ2KpzJcT3DSg6R9gralRGebRn+GSrilVJnLyqmJT9i3Y4p8UTxPZ01CZ5s2akJhUl+vc5hWUr15SE2ConvTOUW+to5eNNBzVqA/qHZVwrRRtVciaoFJw6RtpSV6lod5rnSFOo5ILaeNnaCgbpOwjVhJlj+qR52Rx0QzNzike6C6qE8pxFBSVGdUhWVfvV9aam+huLiCumvNm6NyzoldWF5iz0N4P6rUlEHiOG6TpZWZgbujOqhEvG7ETyi3fHmovrp2e3d5sVJzusYsq6ViTYJXsy97Nj6yZkqloJdbzkNPcJ5GKsKBuZXLj4+TgzQqfymov0CX5TV5vC/Gns01bdeNJG9+NkJ4KkNXtXCSmpBaQ9l11m2HcSx7NpVGsiKDLrHEU7gjwWg/eU1hPmTVbMU+wHBEaLWfgjPV0kDcSGyEp6LBxiG9YU5yv0SKZpKkTGPAel4usa9YhVxYhNxXpcorwbCPr5jghDc+a03Cd2VCmKqCkEN/gh8zhXdK1VyHQXNRNXsrZzWnRoOcYI+qk7xrLGe1RUxyc3Y6zkp7MjFvjcJc2ZNIiUusLGrdmn+TyI21mtGct1R+0Ua0UIuiFbFkSleSnEl9RHmEjqCmi0tBiXqyjkCFTaJpxDchliWERr53os56q0vTfU2YkVa+UowkO5HCHWJVoLC6GIjDPa+bjr6DSsK6yclnV0Niz2lmK5o6Ko6+mJCnPMY5SDUwhElFOYRweqGiS6ipesacyoJ7i1qojrE80082nLjM2Yi1ZHV/gYpYvH1ENdLQzCCkVER+rmhmojZ7cTmgl7SxkZa8sdpmU1DWnKyVfy2IecswwzzMlkGP27I/fUOaOMCSmrW7ebpJSKNCq69qiHbEKrWwcrk+x0pROl5NpZh9YudFv27jnC8xJri90DRfZpwaMymxX6yysLDB1iu2kRa9WE06s5YrH4KOysFtXEF1KYqYxYWZYlWfWDJhvb1XWS9udrmleyGTohq0MErRN3G5MJaivSuoOr9vVTU9ZFFTZbRmZbGVnYagcHHfUdAuiitF3Z+rcFyMa8SIUntqYTiCupdZk15/ez12zDI3xzmuY7ZDUFmmZ5VYpWJ4PlaPQz9gV7i6n1BtfkAm0TiNxEHlY7HMgD1jHXSgf3W5ZV3nl0eAU8o9O4K5SzhfUaeMvq+VuTNjMTKgWWZ4roG9s3K0eKGvn2rjveK4h66koo1tz1hKMHHeZbOHUYJsgjp9uLVQ05NdMJPSkWjei0t+mXGmZi91lm00djw9sWWMtXlozaFhS8LAh5Cgy3HFMdE7ZHlJibrXSC5IhUyQrJZJzMG3plk9rhwlsTZXYn26KXmdmRuVk48wf4WrZoiapq6Si7XHjjZiJGdWYXxXZziuOSbIqDrRTZWhdhaOT3I0kIGlp4N7uEF8tNltlUxGXLdrnnnEvKuSMjq5edxDdXipmlFbZFWBqVswasd9X19haI5vL5Iqh7W8vqa2VaUlxGU9wTictEuqRqZce5apZ54zWkeKp8ggsGRfiYx/r0t8XqGnMHGqsLpDLCiajb6BvVRpdXwyJEKTlF/U202ZsUdXsI89M4lYmIBiqpi7apFQyLqubSyNVDxu0pY7kHyHfnVjXDTHqNhFzb29P4qU0DgzZohfsSGUtUBA0prQbXnBSaedgG6sRXXEs8VFvDiwnq/AYGtdl8e4HmrLNm9VRpm5clV6j4pSna2GQ45tOr23fJt1N745VTGgJzB3gMrHdFdAc0Y7TMZnMFW2z0eMSKbVnH110l6Imz+XaMBKwWMvsC1W1ZBLgFyNZTi5o2t8U1NSST1cuoeujod9IbF4ta7YRjd8O96WbFK8boRTJcXBeo4TXkPIjH9D2YRZYWVBa8GXiW+4uXmPQXA9MVyoibSUGGVN2WPWgkVgXcWwpI+ObM5Hx8hTM5OjKECkVaxmUYk9zzx1cZ6ulySIe3ung012NtQwVbSCl9ZNIn/GdrM3RZ+abDhP1ciAmHHLWq5GrlKru0Kjqy50n1/CasNJTkGTKs2QYoaIwLV0lVSqjiUvJzGuoDzPX020MI42qFEjmbyYVFSRzNBzn2adoJjKWWExsmh/ZsmmeYu2N8+OY4ivhS7UKY2Kj52iLkpKN3FWvzxdYmRfcyuirWfXsXCNXJ2MMMcyzYCcMCjQ0EcxmGascF5LM0s+QzWRQM5wq57JdFBzsqxeN8dMTmvOTjuIcFi2z2lQLmKHzTyjybe2sr9fa2tqzpM/K5mESDh0t4cdkUOSpYw0ZrSKw4REWqe5v1RHm5ioam+VjpIygUyZPlPQnnbAKrRLcqmKJLWgHkO4S0xkpldAlMqmTshZamQwtl8/WBh9jrqNis1iQ8K7ODBkraNnsKJoo5c1l9luvqda0ZrF01RrtLZslC+W24dgU2Y2TsO7ylCyVzBZo6VBuc035MQ/L8mEgbtiMLV6v2kpurNe0CuhLFFWl1Gev0aoxMU/h6NYfHK6ST/RMZ6gtc3aV3PUezOviD5iGTt+VJ2NWUGTc0ueMr1UO4ypaJl8p6E5tqlcHkHQk8VvzcikyK+EZHJZUS+TrDxQWGixaVEvLsKFSzHG3r5MkJOoVT1WloMwN1WjuzypfCTDSjRkbZbUxaxWbyvDfba/W3BijtNwiIiXtle1R8ePkpQ1NoRlUWnB12XKOD2+YkFaHpGiTZBOGCwegYDBVHGlfFrAWlbNhJzHnsWliY2DR2ZOcU83n5XEaHSGVUV/ysPORpWat60drXSzsSl1fpTJKnK5aUvVXH5yU4hPZHZcYDG1aqJfjK5afDeeTZC7L0qBx6mAxInu525KR8GZkqB/n7FJXtK8uZitT79jabFxjZ/YeFjHWMO20Yi/yM7DTz59oH5Mfn83tpjYVD+Ul8aSlTHTZXR2T1a9uLJwOKw1NKY9qkt8wTJ8V3fFedg+2W9HjHjcQ0NGOGK2TYqrXJuIlE5AMLBsVEixhIhtq2Jahq3AbUk8fFLYWMexPFK8e0mUQ5++j2M4xVZsldyrnVZ1nnlHfzXDuaqMpn24MS1nRCtgXzKxe1py4TNHeGOlci+BxGG7SXM10mOmmFuPPjJIyZB+QU03orw2XGBTr1k8tZ50v09iY+W/fdGNtoqDK8M5f4i2Q1y/wSBuorslsiyIvTFhWkmToKGqx1SrTnC4bDnBmECwQ6xVa1HWwnqiPkKLtqi4fKKQgd8uqtHHXjQ1rldThYJ5UKl9QLqjY4pUnkd1PJ+Fs6Smv2gzTleinn/NvGB4U5cfokWWf79zXEvOYzaltEy4ab6pQU7UwZ+ZY8POrlrEL0CTRcQ1g4XPNGWxeqaGT5OkVyIdpmSToENlfNQ1w4ynNn+AvGTVzCK+ireTvETKUpl/gKR5cHhLRJLAuYqqX3ZVP06HOcKMQx66PbxfuobErXBRT0ixLal8VoMmkL3MbImeWoqArzx7amBdp25enNB8n2liv8xTwiuOfnRYwm9tsyRWVNPWW85BUaFGxz+DSz2GW7yqkSCsrGY+yEy5RENUszOgkXOANmfgRKY0yLBVR1XLTzlSrTheOJen1NFDNmDOh86AZLg4r6CMhJlw4XK/b1V1oHW4gnBJrG0yKchNcCtRmjGvxrhOqz1cO8nPOXeUoGC/vWpKY0HAb1K3mFxqv8Q+WdFgb7FGcleQX39iOmiWKia4mYZeMktzL57UMIae28NBNbnGN5BaxLWg0SC2a3lVSGrbop1mnKDc1EQ/NlRnTNBFm2aieU7HPTY2ZLiAlC57i2/CMLmMmEi/oZpyp7lUlFuIllZwtEu9hHs+bKVAkIaUkMkxgsSXSVtt18O9RpO/pEnARLaRU7J0tIs5l2JyjqOuRq1qUCi5ZoSspESjdl+ptzufQmvBs66NyCfCj5W4qpnJIirQrbVRxo96b3KuYWXIwk2FrHhFnknBGLBhksV1L1SNj7lnp5WTNpesxdBaNzujR3h0T7+CmLKRZSujtnlIaHazyT5Dq6ufr7d4t2KTd5mjn2tQtFA5pouWmWidPmO1QV1GX9qcVDU12l9EUGpSdL1gnJF6e5aRf65uliDKwsKWW1cjRbVoz1xWfUjNbFR3trA8nX6qPX65jdaVqZdKy0IpjZ+tYnWoHy+vz1x/XqKd10mDuydCOch3oq9KapZhO4xTqHOamcOJXb1ZLjt1RYaMtkaven/EwFJYrTt0tpUeXnFAYVnEpSRiilY/hU99aa9edmJ1RF5shLZfg6lznM+ayWg6WTmZdW4pfD7KYXpUd1Fwdr+ob5XbhJshPV4k0KrSY1V/NodYZ2t/33HlZU2yOeCqxL7LYUFbacCYnXGoZGGiSsEmUDm8czfASYOJcaSgcK9AnMZTOMCGlsiKmaI+nKQ2xn1ZTkhep7FLWDdMTqBvnDeZzUWyNlebVb7YWkWtSkxo30xnxbWXiOVSiVNnzS5iwICGPoK5o885flkdimx6StGdpjJKsbBpbdWH1XummndpO7TDkzqan5ZpvJ86T515OUiJPIFGP76igHDHo7xoPMVTk4lEOZU/YldbwbgxRsG6bmKgaJZjNzapxrqWt4Z1Qy5ZmkwqH7kjkpE3iHe3aKkqkXEpjS1FLF/ArlBbaHHSKoZRpDFPUWS6bkfJNqNlUsSUsky8a09mr5ljX8SQTkDOuquLLNFRUT9KVT9WSmKoOJavzW+0PrNWQWPSTqkwxjCqWj+WapG6f8eboElywMK0mlNmxHHWP3WrPWStb423eWeDvcSZyZQtpEOLoWq50lXRl5mLyrFEwzOlV8dxojHYg7VEQVSqUzt2nbU700U7hZmnYs07hE2EabJGWq2gUDuFTFi3eoVfnW6/XeR/mDCenMVMcmjVzFU9nlNtyH21Vm1bxGkrVrmRWZKRVjVudMRRnEyvN97VUFhQL0WYxFNTi0/UvmA1MIM8X2BUjyFkqFtzbzYkM7dQcoQmdEXNRkNuYYyApmiDnWvNbVh/udvWP4qLW5V13kBbZElZn1ZqeJfCY8FZuq9fJ1WzhpJtz6d0UnWORr2IwtJPbaFhu7LFfG2Iypwws2dYksQyv4An0DPTirvEdZmnmp62ZD2VxDZ0csoreaN5aKJUQrfJXM6eZJFecUA4djbTimY1UZ6Zu8vGuHafNixUqr2jVmnki4rNT23Uglp5fTXLlLiySTFojo6tKC13Uy6YkopTxn9sia2eM3EvgIWvIKySs3KFgIypX0jRUMe/oK1kfbk7fHDDmVSwRTKuR0e4qkpte2Z3oW1NbkBovVZDPcWY2XWB1WBGuZ2gvLpmpchgSrYwuCtjpm6TsXN+q92EMqhDq6QVb6x2a2aPNDw5R7TH0V1QPkhBmbg5e5KkK864RbfUc2pbVDo7rjFteV2NSzZHeHiF0GfNu3aLfSR2QXCxPG1kfEFWbbiPpHQqJ7mVsXGNPjCjdCapTIFOPF1rXuM+RrhqVmjHqk49UDFuosMxlU+H3JFDUkuojMdVpS7Iqla7K7O4W2h9t25zxI9hrCuMealiq7HBoKpYLnrIXbKoVU5Idn06yjORhTyAckahlipqp5U9lGqepmGrZFS9OIfagJu1oXqbiJZun7OkuaY0jDK4Vq3BxzFvt3+Bu2tuqz6mcsJXT7aCv6iYaT6Vo7e6OSlsbNdUgGUix7RFOqYxgrG1MLadNdvWiWmpqoxVQNJUjHpKWkhyx1BGvqdUhmHigYVCoE+zLVOsgFmHWFp9i54nunFyMX3Rs0JvW6W4cC/Ys9C+uohGwTkwX7ebKUMrfbGJK69bQXOwU2Tgi3lVStZ/nJmBstFMqpzBeaLMlXRaqXp5P1EsOsqVa5rBi3R7ZURwZ4tsR35pm1XIR3AyiU88UUqeP2qTUGq8kVY1e4FrkNx/PFagri05vkbJQkqeOVg/N7RnXJRpYDmpeF2BpjHFJ2hEmDqq0G4ez8SuT4s5PXZsRmnRyC3FtJXCLcOXUzR01bpLsY9bX6NNeZPTpHJQJX2xfpItpFNLY7jcR051q4hcQ75Enpe3Z7wuPKO5o60md6d7hcm3SICOfcSt43c4NlpzhDk2VZzZV7t7pWO7l1l7yTdkloKrScLByVNJwawylmZ/cVlqb9K4H3u/NDGko2yNsWKCYcPdXalEf+BDTmNXS2hfQmNFsV9btLpoM2yjWF9wXVNjO4Wf3ETMcJu0MTB+01ooIKFxkCtGp6OPomp5NIpsO0qrqZ2Bh2ZD3V5DVLqxJYtLwsBlus1JZEaYaIYrh4Bdw8+YnZS7dJ4+Mjyhfjq2WlxxfMqF0oRBiidcd62kRSvKWJHOw76xOXXDui/AjK9a182dVlfRwpPDaHQwXTNBg51bq2TPW4+AOdjFojWeQ1qqk3htO3xhyJBhyjTLb5zJbEhfY0m5NGc/z8qVq6jRga18b9c9Nrd0tqJwpjyffZKHXa09KqZaq3XOizZxxy2Ij7hVl1p2w8pudLhinpPOy8p+XTc3YU09YdCATTQ6fWOIUVo9rb5CmYW3rNcwSKdJKEe+mo+ydKW9tWQ+c3aKs5qlTdk6UD0wy5/BNKMkyIlhcGWRl4hpyb/YO89qP9BxhmxmZ7qjOYLNkppNjHqjjcnWV7Vzk7mRY8k/bYhmQtpUW2I6drFkjnqyOuGUaa1NLcM4iKe/K300NCxykJ3RTCacpj25Njt6arswrKJnRqlHZbaurdilOoy9rp63ppasWZCa2G2Ye7O0SCdQqXJFI5yJZTK+N77eRTvUral6mVY4kchalS4zzs9aXExxKJ1tqSpgTXU1x3LQOy26qcPJPadwqYtZJWauYJihXm9ecTlj2aFhjMROu5uAxXnHezs42LJ+KcuQkY9AepKB3H5mOsCun2CznTtjPbJRSKvXjnZAiG2Z0pNre3mWd7+vkYiSoEO0azLHkVJqUnanncYofpJf3pBswYLAw3xSxURVjC0uaYw6n1VuYSxAl6GxhoRtK4Oya2tWtpO8lXRTd0TBR0JMSMnMUD6kyXmvQ8PBd3XJ3U18etAsZcyUnZaqT8K/PKOZl6I5LcJOSYFi2Cx+bL2DZEOFkZKn3UZqUJGgzHeHO2qcJb1Zea+FM0ulHVMlj1+TYEpwUnhbaE1yv3pVMWSLPykmuZhqQStRTYMYuDt8S5ctXVNQtFCxaYNaLNJAlsd2uqunVSk1dNHRcZBEzEuLvE9OzDe8QYxOv4UpPjjVhLsyMsgxjDmuUTo3eLp1IaJKPF67iZygeKfKhVNhcM1qv8d2TJRlV34zrY1snJeYh3dznJs7LlncQ8qWipptYEZIOni6pC68P5XFoqN/2JuMQrBTX0nJmrV/eKqIm8yiK354grpTS3SdRIoitcY1QNWsoYF1rpqqK2a1kdG3ol41gmfUMJlHOSp4aZMffFh7smdvtFdFlFthqYY7yMi0N6uVgK47fW5Et3HNxDyHObRzlG6Gx5Ftx4EslLx20p2ntKPCg0unjUyAn8qOanhBk3/QfH25P7hqNMmkTYMrdZpWh1VtXTw6cXG3qY2arY2V0nrFio8mRMBpmWt7UneUyCWwnK5siU14mkJVf62Hiqs1YVQ5nEq5S1AvjKhkoZMYGaJrZ7aQw5A5wx29zMk9ZjGpWbJUfrlESc2yTslmfbaIRGikosytw4KJw4C+U5GAWS25u4CqkravlKCDo153toRJpqsnUWuxu3V2Ts1DLmHRL35Hb5xIlG1Ggcp3SEyPx8qyhltLPTaHwk6Fh3lSKJRTbnSBLnp9qGxHUjaKSRySq4mslN9reXGnQMdzotCXgoqPllhVNqg0o7dQYdmj2X3D1IxG16k6lItrblCJSUi2hZdKk9K9YIZKrpNmHmZVX7ulmc1XxrqXNiampGeJKMVcqLZcQGpnMXpwdaK+OtY8uVJ2Q4BMjqE1L8CTt5HDdSS6ydNS0qnEzFGnjbePs5Anib5lVGdZr2Z8sTxYQKDFV8ZeOJjIrZwxiLCCXXBzrW5uOKsgoD90145UZrdxoEiwZ6Et15U6L7TKW6pLKzutnrdAi5if1od+ZtNSiWIxrxy4W5pvyrFgLHbWtotOi8tfN24xi3JlJLI6dJRUyVDfQsi4klNcRLVCWq5npEa3pSh7WqlkSMZCnUO8tXCwyp/VZF8+vUmhY0S4VIsvT1OoV1VuJV7OrStZykFZUpGQZECno65Gt0jBSMWmk45Vi3knq7vdqzpLOY68X6gwhZBEs5NDnsM5Yqcwp8fBzK8tSJR6vjl9ckuKl5Km20uWjb+Vr6OolS5NtV20ojwrhaeOg8fHMsGKJUIVX67TRl84rs6fTFHCOYpYV5PAS06DslrIeYeSsYSvehuavMaKYzibbKVTMRRrMr+SdW5eT7ObT2N2eCtRKoB/l58vOS9SsTWaM0iHUIKobU/WkGmzeZsmT6m8q1hUxTJumjNagcdhSqxGTJixJVGeLLTEdT3NYG+rxDRemZejYmSvJ4hfMj5Yq6HQa59N049dhVZ1RGZKQsNYcrGdkaGvHUO2vMayhFPNb8a1h3pqfIK+PB6KkkHGV0PQTH+yJb94t8l5YrZgJ5mHJS9BuclLUtCzi2bR3Ya9tX8/lknRvr/GQbZjTpV7nz1aeJg6OH5shytLiXW7LbV0SqItyqeRSmVXQ43Ay52VXDIqLqtXUaUy1TWFvHF6QjOffqvHW88xa1WBR3GfzZZOlZKNWkSRlaGpv4JndGw3aXIniqwzj4ttiYmJaKuNb29vPSeMhHm/PNBjhEqMj9mtlEysmcTMa6SAVrNOjkptV0B8SHGhvpmVql52ylRxSWprK2kwhXeMJIarpzdxMdJwUIDKcKrDyGZMiK2ZX9CKKV2vsqJgjFKYTy6xXI9+M1rTu5VcUM+bULZFeKp6iVQ0iz6ivzNEpX2ZZ1t1TWBMp6mCa6tnYHTBp0J6NXJ0SWSTWjqHqcKsl0hEwFeXRWDOptV5cERRytc815NnhzKQNjk6oL+uwDqfkl1pt1GLs3pKOHRC2n2zi8Bo2Hhvz2tDO3lSTaSOHy0Ydm9TRq5pOHerkqcbp7q8kZRwqXpbvVLag0pUV9A23ntwKKuENdpalESCSsBnk8q8XrdgRqFiMLDMKMzPgs19tWGPuXdlp4qHzn+1kKUxqzeIuFXPs0JpfqOUM11ogadCo6aGVVqeZce9yDSrfEK9Rna5PpJHynM21CysaSnNSIOSmcXHbC+3RYJ3u1ArVZTNqDG0f24tbFWfxVkqljUnhaJBv7i+SdNfocUvpMGKtJtxRVqYLYG1cpEvZFi2PLcpdHWmrMGnklA3lrZ/VW6lkkF3kX88eGI6y2RrYyLRkOJlb66SlxeoiIu8xLNImViKIo/GYo9Znbx4K7gil1pKUMA4gKk0c5NwUXdUMnhXpHSRlX+cPZ93rrdLn3+HgkK+h0DTN61IRGiygF5ocdF5h1lxYctcszAybKa3VU/GpC6jrdUwSG+8tK5wkMVRhDmrOmRSgl6+qM7Ihzm5qV26xka6Sca5XZVCPHl7FX6BXSiOy3BibFW0pGaFPTvAjL9RcbHIN1E5P1WFd4YxPq1nllStp0SEt6aP0oifK7hTUlSx2X1mp0h0O9SrJCSmP3qaeHOieNdhhkKril3AtWVnbUDFTEh0YkfAaa6eKCw9cZWBsE5SuWiKZyOfvcCwE5fMmzTfXjamPEpAq0E5X2iAYGBOTmuHRYmGVzfSX8fAj3KWyz1n093AisNmOo4wObdSoj1hVc3To8R+Zj2YxtZ9W4NiJKfNxbqmiJ2zObY9b5WFRoJae0RHy5SNliWFsUWcLyK1mYefgLfIZLynUG28XsOroYYrubCSTbKJKYNjlqS2rKFTn7RfhsKRMGS6xNBcq83KP7GpYolsNZKQtsZ6VVpttHPNaC5iz8dhLjs+ttOcR5fEREzSwlljfpSti1E2Ro3ParKbnZe4p1LPLJq/TmFkSorRXIGjedOPrnm1k2KGNSZPLGs1RrM7rMdkMop2oLRO06nNlpR/Uk1sm6NQh1eYg6Efr7CsTqKPd8U+rrxSXrQ2s56zvW1ifJ+5O6h9q6I+speNepGe0IeJljZCIZ/Kjpe0kG27xWe3yj2YUsZbLYOuccqLndF5sUnIPZxVLz1RLsQukFpgdrPcjTXEkSQoqVgwVV1SXNynKWOovcGahsI6kjGKup+Xel1aJMU5Q5O6yCyH0DZlgq+wmxi8b44tSDfPXotRzXd+oFenuktKqLzmppTd3keAMZRwy3ZYjbPQQmB3kDe9xmaCK5xrhLtBSZOwd1ZT1kSxxx2+qJojhph8YkhlrF/HTqFRbYWcjKguOWXHrKpDjkrNk5azJ2GGyr1Xqpt1fqt4MbuqeibQSEd9i46R0njXcEe/ks9jjjLjU4rXRe1NNqiNlbuIxCeIMeFbNlZWjyw4raA0sC++iDNahYeKZbvRU1dFR06ZerovkXyoTFRqOMZohDF/VSy/mow0zIg2s2BIpck5v12wf5WuontogX14cVFIuDTNaGNrPnK4tTWAJaQtlFFT12GmlKhBn0RrZqkpVI6gjje2fzamSKaNuMxXO1Gsd1g4QnJVfX2nSHbHMc53nbXHxKtdV9eERG4wNpGQmCjBbZo5i75AV1aTPXEpa8K0YCZimm3WxGGSUTYxP865zFhWrI57nLdH1OCRf1VvOJqXZTHCTZlMN0FjN3ukqsy4sz1RYU4peJ2ko2snwTqTh6AvozWubJ94gk7TJ4N0dUVxtYnNRbzEiCWAhn14xsAlXXNknUhacWqkXypSZpOpvSKDoK97pqC9Jjwoq6udto1Hda4oTajHtLSOQ0k3nEezUrtfjVs4p7tyy7SFSXBLi65YZnuFSLh1YpVHq8KYj6B9yDomHIejMCmcf0uRKTSqvFutfMdwkcy8wlZ8o2DTXJCVMrFtYYBTPq5wckklxqkmlrLAJki/N4zInCdlkMRJkL+EvM9Dez2XtF1ioV9JGXNPj3dbVnxuzd9lmnlyghM2RMbFI9J0jYg0SY5wYLKhh5N+Wy2LhduSkpHPSCdHsbSeUTtKhkGHu9aLUbM4bqLKwmK8cUfMbUpwhGk1RCSWGJNpv7mNaTx7zeNgNYbHbDKOmEGsqX+tNVZKncZd1jxPwaKm4M54hkPERMTNcIjLZ4k2RoJfaMV6YS2zbYRwLLXOhU11ZEa9OWuMK8JbS8ZRkoqPTnM4V5xuvna+KX/GnpyqX2c9YW9rLmJTrIq1PCOUlDJCR0fKZX5ERi+wj6V8MLCzP0qJYzY7iUq/zjCcSI5+djFwtTaWqa1DZKjUbXO9V3p9d2w8uWxDPY5mrkNjMSlcyW9XbT5aooBATTPNKTHDiltdyN90i4PASbtZf65G2HVYkJySqKBOlbVuLFTAjum0NzaEiD6TpL83XGU6jIjROsM1om1DpnPKeZadsy2fOWS1QRwiUle0VovUyCzFn6FDRWyTsXZXXahDdLJLs2dTrWU/Sc57nLhqq0g1zFdPj0Yy0ndcdbYkUrirtV+NVkS5sse+XbJAaTukoshnyERh1ac6qnbERnGgMpyWxV6WrzyWLa9zPX5Uvjd+wr+vV7A8vYa6JUI5s3BHoC+GZGhllWSlX1ZdzWJ+Mz20mHWRJp9w0U+2V0+sS73BIV5suzpyvTGHaGc4krqzwceTkGlTrptPZ51dlc5QNZCCxq0gy4gqyYk6moPBKERhvHbBhMMwkLOCnEOaMZG8VCRuwJHRTsJq5ThfbHa7NYtOSm26TGphWX/ImJy1f9UymjGiXV4icX7NQM5WkUDB40ObZMWqjV1vSp2AREKFYl9glmeHSmR3hS1ow5pMKcAxmU1chcXGsFZQfNFgQ7lWYE9hPdGPUsA2XH6PP4xmuEKKnH5airqxX2maMU69e3e4aHDHcJx2PEZIeb96jo1ugodEy0Z1hLGOTZ6Ab843nqEovsy1x87ZibOWVJyeOiWoiSlvmUFhMLWkZdLOg3ubsLsro6StQJFmiluNtXUzn8O+ga2JWHDLRE1bu8PhoWPYNZ25VmOwt7FgTWJ+Qjpkbow/UMGaZ2szsITbuS2hqMdDQpDbY3JJxhJ+njenQEWp6Y3ZxTJNKqiW0pS1Sso8q7CLxKt+Qp22opc1kTTCW3BVUnuuWWCV2GZsXr21K2+kPkUMsJ98wkexhSeMyTBBUTqGyqxZsLqDjpGrkqt4s1yBVENnfJDILLps2lxWa2WMj1swfi1bTj9GMMfMpyhEPzafXDm6SLwkXKG3nc3ZcbWbdSoykaiPtqpseaNGMIB3mZuIqWzCTmZxidqUrn/kO9u4v2EgSag9bsNFUDkwwcRjmh/Cc4N+yW+kp3k6b9d0s0+2wKJry3Vs6kxcNoOi1Cxc0M0hb3OByZrCuzCkVmSPZaaXWE5neTV8gLpHQlk4ryelxah+dERIUXrVet9MjJUzUzjHmXlHXL59xaxjPqe6s2/JxSw6rtJ2otlOYkSo5JOfpMeFpE9ji0rfnlSkiIliqco855azaYdvhmFjP024mE+VZnGAtcVsPaF4jqU9iEXcckXe0kw73LhyxU8yXZ++s3OrT6Jat2SAO79SgIXHS19Hytk/ttdkcn3OLLJKd6GuSqZhu1uxh54qnKFSNcassTKitTImvVafa62WWRmNNKBe1VdOhnK4TCgxdK5TscuhRomfj1DVn4KqypnAWXupN72uoddDyzg4S6c5hrxNs846Ojqeoqm4RDjfs6qsw2KcSqA8jWOZatQ/fWhOiYJVR353Tkevoo2rra8XcUg6y5MuPXWzwiRkNlc/Uigws6dNeSlKO1+9yHGD20qZfsWvKrdSRNGvMEisUXrLkUCoSmohcnYglM5dej5A2DC4mVuTONK0uaNeo2Ndcb3AqzmaxJ1Vd2Cwd8hjmYk1U4qydrFeyWWHq7+pVLSVS3d4zV2rJcGi08CXsbtQNLlvjZunc1NSPyspQJPNaDThP5pO1EA4U169TJxRup1a50RXN7YhP8ajWnjNaICteoS0yFansxJqMa8rtnODnWhKp5suYaoxrGKbaoxBXddSR5LOhEslsLhFuC9iYpt8IcSCrCaiekpjfmtuu2gzj5Za2mBcYqYhWMukL32/rUPMiZ+zpHxzaTerJK9qaGNKfK1yqKgw2dGnlielKofBkyrAhlxoOWhqP1N+XHPa5EOGMjy0fciRWzKScHJ0Um6XJMfEb5u7UKlmyKu7fh2xtdzYUXKBsVBdPoBmcG1POdQqWs9Cqi5viIVSPI07hJfEyqo31b0fLU9GlU9FoG6VmW6LR8/FVohpd7yebm+SrlKNnb05lmgtsTFKbyafudA+Yry7mG6+zs5hVMahsNhSjU3Caki9QLY/eqK1T3+gSDmENXmUlio/blvOa0fOb1WaX7NGUj1BiUa6X0cwdF+2Yqc9u4VJQcfAYq7IfhpQd0uWvJAuy7FYpq3W1U2YuKZ+ZTmMV0Jep1WhtzhcdcmicmBDmZxZkLUzrJtAZZCzozzDVW2fdacus3KIamKxzHEsbiyxrMaqjMhyVJ2LfbWPozeqwp5Tk9CJHlZ7xF2RrIxDQJlhXSeIz3thgUp/0Heluku4M5i8Gm7Gb5OByXFrKrIhHKVxaKbFsllGMojNQTvKsH52aXLOn4NoV7x2r6pUvlI7ysm2P0nn0aVGRWJsQXWapHXWfM+dKnXTOmTHUlJGl286kniOxTXHmVQ8r4O7UWeHOXDOU7Zfwp3BPaB9kL5soXRq2zDD0zOLXpRqVHeJWUfEutGWT3RRatUyeFO6haydRHSkLk6zXrDYUDCgV4pPSIiOfHHIxMUkU4WBp3k4IZqnxHWDKkCjm31qdCFQxjlepIhXUEOZlEFCRsO3nzLTv5umfkiQM5bDPUtEecevuFpdqTu3mllSnqk2H5ikyaOjKKsmytJ06EPwhcU/ZcinSGaBbExKwF2vy6FxuYQ9Q1hlk7O+JsnNQ1uLyJCruXUvQn2eZLtQOD1nemc7izDFvrAqdT6vox02gHPGU6Rqd79+wCaZTUbNhYZTSz6+PmBBljpGN2aKi12bSjawMnoayoCjV4OtczlAp6R9at3MecRkhXeXjsCZgVE0kjC+Y1mcx4S9WNJzWV51iYh3Oa2vN3Z8OmXXQlrLY0NOrzi4dcCex8lGsq06p5SdjpWYqkcsYaOdW7op1Lipm6M1qkM4bJ6ziE16ap3IV9dXUrMwvE6+zXjLoaGJn6CnOH13QzyyvspeYkptSpGmJ4Q6XCa9mJckqKJbolSnizY7ezxsx2IoaManNoBIQoGnwkWjQrigmbuf0ktOxS5rvIqHUitprUE5LNCXXoOkkGdOSd9numbHr0dIki/p00FT4FB/dERKS9KqU2pCvD2bkLhI0kNLncI9YrmUOZS6o7WjpjhEslBYfV1FIZSUKEzEj3Asj17Uh1h6VmKujVnJRpmxaqa8V2vBVj/JoEvkQMndnH3BZdq1co+1sUSyZNdQnsF0n4B5LofYg6pKkq9DtpFNqqoltjNqQTmLZUfFh3gwtZ2dXi6npadWuIJjcTVkuYZqn5U0qV21n5s8RGyPWam+lKKpo0lYJlTHWEuUlSV0UF2qaG+5XYq0LEg7oEN8g2B1i7g7rYYhhtFGos2OeF9YdY45r35JY2JPkL5Zu6eiQnwxmJLPmSvGpoXji6Na1Z1OPKFUwE5TZLZu0j1VmE6WQ9Sma3tXkx6mqUBINl7RcjjMk4laZY6mlTF2izDKuql7fG2SyplsM7LFl7vaWkVul1o1vDjRb5tUxGDR01CMZ2I5va5PMZ1NeEMrzUTIR65eg1LSTayNQHo+S3q+eWymLqOEY8y4QrhqJ76JS2/AT8aIg12uWMbbWMJHnL83kbx7N0M/Xaqqe7DEi2hOj9/P2VuYbaUxX1a7QHUpj0/NU5WWRn2VdIVpv6lXVp1Id2miW6+FeU5JHsRQYF1FMCXNmMRtr4OyZMdwaWYeqqZVZZezvUAraZ6nVVmFf7dBlL5ydmxPJmKvor9icpmjSMxUrzWlZjK1S5/KmzWVToQ2W81O1m9BqVtTMKqgqNeGpY1bpplSHpWViR4ceoszWiemqSyQgXXoy081uDsjO41qrz+WZy0spICcj1aNec1MjES1lkyxeiYzcJXVh6VznEifWTiDvc1Bs1RMcas2l0Q0iLswLn9DwmVIotZfMp20gq6ui0aVKctZu5xkcaNVrlKjF6rFVkJ+orWrvNzhqYvORzhyhyFjUbuTej2rtGhRhV5BZ380sUaLVpyhf7+gRpwzWYVgRjbEPpNKuVJDhr4zv4ZDq723vmi3vKIkLYugQXDcOb1XvG68ob6OSZtsLmqdMJnApVQwU6NwlnqFSLVzeMWDfDtpVox+wISPlIl6ystQejJsM7R7g6M9rLpqnHyRuLWXTmafTWiVu3BhicZHx4l0xi5DwcUqOpNss7psqIGIwDbQqSuXXDmJknQux9k81jmBO2d9VoWhuZbFUj+FuyXCrUlJi2UzsbpEQ0+ZsZTKXIJjk8hrI2oqklhLzZk4ZI2ndGLWarpHsWsmYMBJtbVCvS1TuKtrpipUkF3Cl1I0SJGILH1xjzt+pD01cNFgtpgwgD1txNJKLZF9xSKIeqjJisW7VruJVLDEsJ2Gcog/UFR5ZYSr65FPsrXCnmVKkXtNjlqee2JibqufLouZmpRBgmWhRGGjeVTXpGuvTIqtr01ObJIkjYS2RNpxe0d5rHlmSlOfe0rSSU+fc09DujOzd0qdqH3PM6+NgL41wEqxd6V+g0WgppWHVJNovYa/YkmbwIKciTt4QMg2hXZV1TFprXdOjiKmp4szUoImSTt+n068kYBPpjCuhoZTRDNpYY6CVa9PQMouOoiOJ7RMcq6CkM+JMohjvnKobJKHlYNxt5yPVjhphWtPlcA0R2ZaM9dkOWuLeis5hXG2bkrTfHROkMSGt5BmelFlZsUzLHp4brrKUptuqm7BsFlQujGgv3aoXEvURFEuoy98n40kdUivcrt3QDhEn4HNJH1upoqyUi/cVJRgPb9sdGnkez24MbavYLpSN4mAStyZv0Fi1KA4cGzAqLt7KCtHr2B/zxtstselpn2RWNR5oS+wbW9Zsrl1NsZ9O5hdsl9JQVGIMosyKJHHpoWDrImtasRBnUiW0FtgLaqGgkysfqWlIaQ4tqdpnlfUaM+PfylcmL1SO4ZHbkLOwBazuJd1ic/TcXXGjYoucpSANVJGM2owlGuNuWSOjXWIapAshxlrcS4he6wop4unfmnYOpCCO8Occ4LK2jV0YmJHblKktIu4cnZVVkbCrrlEaMF8xC63Rlqdvr6mIrpgb05j1omFI5V/W3y0J7dqhbxeVL5sWI1Mgs1eckyZlJ6VUpZ+ZFhndnQyPFdKxZmrRI82fItdPrulP66dqL2itX1u01GhcTeckFKGu5x4JcFW0FW/sKodvouxHcLDW1RUTLzOd6tdvGK8f0yAOKeTMYybVVXXmzNMp9yOW0+Xqq1ZQa3JOptBgzauvywzb0kyhT9uwSC5tn2NjZujyjRYc2fAaI3ILK1vHkV/Z6Aym79y1DyNOsGTTTWmUzqAcsu8qHlIiEt6WaykbU2mlZi4dECij6aqupOVmpeNWWov10GyfWKgiZ+mhji5JsLDJJ1QZ7CpSMt1PD+C00x/j1qImYC3wJ5GOoGrvYhNx45sqcKgXaJ9qZp/k0g8lozbWkRTUNAoRYNdUkVHg8hWWXXN0Vhw46c4WKBnWalEZXZHxluFxFWNqsiwp2lhPKJiWawyS1OwvFxHc0LZhiZJiTtoQ7KHkU1IKIOaZ5qKpGeOn8oylIlTRYSVOX5fW7qw0Ch1kmY4i3FVj6y1siKQdsS1Y1SQlXzDwYvNx1isTUM2biOOi0gnUoeqOTbERyKM0m7MkTeMjyq6I8S9pqOidVKisoFbfwy2LEG9vcQniVODSsmHlWqXnK1xY3toV6pcc4leRq6Ls4NsLr7JxlI7YXo1n4iFQtJNQaXaUF2WcqS8iU5ZZFCUqFZwLkShoUXOl3azu0q+wEddLItHUHaYobvHPb3EZqFjhF3MjYeY0DGLYMNgXU6NgpvOnpvAbCtLmkJRsILTWC6/Q6uAYW1znZypkaROqoo5UFXDZsVcO89zz35cebk9djXSgsTGq0NkZ6yiqC6hKnbFgyuuiop4YMM/bUeLlsfMfoq9e84zOsCccTW+mJTBINC/pNQ9lZOYd7etTI+fxneoW66RqqhSfaRxM7Elc6aNepNwQ78lr4W1QE3CVlhCblfKV1KZj9dXVU65faeBr1JgQsmfUISZ0UOKv1x1V1u7gXxczM94R5S4j6pYToS8SLt+cZXWeZhUODrQVZUqZ4XGgLSRb25ExlBLSFlTxU83y89wLIRscD7QnYCpYMONbb2EKJOqZ11lr8m8UUd7Vb2lv0lpKmtORdNEqI6kbTmLX6+gpL1SIIwyubbRs4Br0krBoDbgoCiwWUfK2rORNcSmKXiae8N/HjN8sWYdf0dcKM/KRWlrw26oi6DSTZVPrJRQt6akmpAusD3YhS6RgKemSTqHtbiLR4SZwWCxfaErkNmoSXM1cFRtblE6X7OdlWNqZGS9N5pGbp9dt35fqaSpZKYsq3GElD9jXZ9rwEJKUKKRnnOMfaM9xc9eXmjSIVijJkSweHY9pC1SWq2Mjo63taC4L4CIoo42anOyTVqrOKKktCWfNZktxWZ3QXg9kNarRpdTws88oXtTqkBik0yTo05PZp6YdGrVyHJTZY46N6sl0FdapNt/tU0okX6KpI5AupHcTVFjcmy1Q4hUtj/Po3I1sYCjiJ5UeWmPp1eOaITERJg8nzV2u5RvsEmarqSsLm2GoZU7n6SKsmQ5TIm1UZG20YZefOaGgjDLZEmGI7jFK1Rhy5Omul6OW1NRr3K3rKIteThKULtMllSwdbpwurE80JVnhXJ8ioFCuqe7gTqsjoiEqnV9b2azzzpft72CTZCRnzCYTYzFPIfAYRhaop3MmNRMzLA1XCOOjq3gka6monQqek00UZyWcierpqegU0GpLKSsK4q/bDk203czJcVVV4Qpuz6eW35qTLvCX3eiR5etMVuXzX95nGRRR9GYj7unJ42+TTtFQahNYpc7uWQlSDeSvLybcUGob5WOQ0mJVudps6tFQIDMmcg/w5iSYZJmQzV1ormiREq2145jpHpfl3NdtUK4aHFwvCSSplqcNax1WK6vRVZvMZJ7dEM/byY3XJxsrqR/ZrWiyUPJgzGMJ6hg0cCtz3mKeqtot3aBjm5SSX5oi7HDqKqVkI67tsLLvLCQcaB4jbYyXKFWa9KNLUeAcrJhomrRS46qQsGFskjAshyk1CrfPUXGfk86uHkxpENu2cudj3uXbFOsn5OgJ5u0tnREUCYhiMB9Wlk3zsyaWEvCXN4+S/Rq4aYxMKW/rmMpv3M9lpo3t56laXpKgD2Omk+nj6JZjHCfjpQvaDSSw5ww1oKKaWG/NU+UX0pMeD5CVsVKkX2BrcM7SLF9RsB+ps+bn4SPWbdqQYq4jTxDe9iGr3q1Yqw1ZVxXvlqZicFd6ELcpYl3ZU54glqHylWEpMO9a5sySaKtWmlznnWWnV0vqNNxz5QzNlKDua+9kUWzq6hhYEmpe0AvanM3i9KcVXe5mTdEaLlYiCypczC8e0QyeNZ0KHWVrsbDGmdUczecuEOQWIlUSmFgXHE8XsA116g7yzSUW0WQq3ajbEWPbIqCy82IdK58VMd9t5CiQ56u0oyYw3G5gMNZtXSjPndPbKvQLzUyuZh4RWlYbopJtbWKxr2wdWmLnKZ6ToOZtsE/LXDPXDqYQElNmZpbjV+BVYxZYio9UKajELulrW18wcHVeV9Uf8mA0kWBwG92mHZOt43QrTVsq4iYOzlXmEI1RGQ5htxL17zDoJNZpZa9oEDTVXKTl0yrWl+/y3uaakdOnWxzuEGV0teac0PIxqiCMiZktVdTnnNGm1eyTCLLjFCDdDaSUsR1H7bKlIiDjptCrc04vcIqcWtPvK/Jc76ckKREbZx8hEfROjQ+j5g/hHRUWk1kaKzCUsmzXVeNSpfgvcSK0krW12HDnr0zMnmbOalUfcVCTFN2c0SQvWSzW26kkcS+Pm29c2WrWXZuUpWzUK86KJJ8fJ/EQiZWv22FRziHPqw6i5Fzg7S1uMiQcUubP7qCVphMVE3RbkJzbIFQfa5WPXslvFYVrKt6WlRMXo46ssQoYaWAvHp7bms0e3eaV5KXNY1zLR2ZolIydRtBsoUoSlK2Xmxcc6TSgofEwciLn0N/UIUbzkyTj2xBQXVnUqV3xMV90LZUrTecwLtTZWudTHxLvmmuIIlnmseEf2w7g8THWzBESnxpKaOkm7xkdatLal6AQIKfVlFLqsjKdUStO8CYc0V1aZHFdLcoir55RtBTQ3FiQ32QaI/LwoZGQMBSnxqoNMJEw1jENzm3UkY2nSeUOH0prcfNcXRqr3S9hK1NZ0a/wDpLraObjHyALoNnmC+2j6qFsEqaNLeyuXanzbV5O6bAS5Innbh9LnB305lgc4mOVWbCSmyVLhl7Q4E8i3K2zxaRQ1imJdCtq3dQjlgsx2IqpD4vYHe4U9qBQzmuR2WaRXVbH5ayl0uTZ16xU1FiSlF6qYQ4wyzUKn6VlGRfiZ9CgmQ/pGJkqFRjycjNbopkj3JmZEFLT7U4Ql/YhJ5zZYXGaXeNVb6hqsQqgktEKcNfqVk017aXb43KOF9DnnJxlQ9jxii1j0PAOV83LziYnW21zUVlXms4s1Bie42dTE3Jj4BZTzWzMXfJqEzA37ljY1VK2KArmsFaiqhUhr2qI6envJ+Hh7Kk3XUvLlqex0OULMQwQWqMoahlbICcVb0npByLVK+CcGNsKLieorbFc6upynZkVkCWqqFBpml0n5slT3d0P71BOpFWkbJArUG10K+ayzQexIFKMMfBaHtzbHx8NKIjmSpolUOEj1KgL3qPZKQ2WGvZmWt62n9UvH16OJVuZimIQeRNPdOKU8m3MjyJdUq9OGa4k82EZ5O+xYyhsUIiqlw7bJNDbLS6xXraR1RAk+Nvh0W3KLO4jn3Tb2XZQ500XcA8raQ7X57H0IujmtS8M5lFgTG/kC92XqigUjnEnpGquU2yoYhwqs/Tg86vJUgik600rXwxZmdUWaq2om8pt0xeWorUK0J7UIy0a4+IRpgzdafGK72Yf8Eclhmvr8G93XdPlS56gZs8MUdAStO1nbsclaCjbrOBR8FhRWemgrAqZt9pzotrpC8ved1rwWOxzdlRqY/SNGfZOaGbtHamjq6Bp5WMgEcthtSlb2KSjq3GSpU1q8HI03NiezZnV1LFTH1G1jSEnjpRj7qkiK8ovZubKIepKKCUQTWdTDs3RU5QKo7AnIS/mrR4frIrl81EnjW9TUbDhptogokoXqrKd5N+N0ewjVGl31hKpDiSnWUzNc3IXVeeiTW2XKhwuLdmZJZbRkA9VX+zO8XZUU3ghzqLrTiUsTlLbVWohS0qa1pAYz9RWqyax9UkhKU3aXjJc3OdT7+xrxxif56piZsrc8RHO0WtmHE8pqx8c4Vrg404m5ZyQD2trCYoSpvNotKSf2lCSmU81ovVnXxdb593bkPRWKyBv6OMh0OIylxlZn16pz+Zlk7BdrxssV6eXH9aZoOcdzdUOpmGVbpayq1SYp9MyXi8Zk/IqtRrcjBMl3ysIZNbPjOfXZ5up0+0LoeupDBHbeFErT2T63F/R0dE3GSzi0WIp8hkXy0zY2mXfNM3PrFOMpOxwzNVb1VHw6A5lR6Ow3a+K7SKUCU2nXTDwU1QGKZDvXemtHlNXzMxqLqmcah3Y86JaFjvUkiWWrG/dy3UZdt3YNY0vTundoEyamCowCBMHkl6O2AdjbygY407ej86qZE4bsHSdrKLQXtzeiWvYFuCR5uhuTc8wZarip7FfDaByVa7sDxOj0PJRK9Pi0BVfUtsW+M8aouCQlS8VsMvdDvEvJc4XIS+NkauJXZ6p41qUF42fWuAMth1bJFXa8t8UnuyNTtulql5jrWmS0O7cFyzXrmOuS9lyHRCkJuQIXIfa8AkjJdymnWZTKG8yWmcOEpKup11iyuhtm03h0FmPcu/MqSmp1VzjsLSqHx718ZHUtOQbUa5x8BPbEPAR8dL1DFGQk+fUapwYEWcesaCNVRIxcamqzmTdqeM2czZfaBdd6C6Z4hdXVmdtT+ZsnUfaVx2hWaHuY2tl2Schb3BWH4kOLtBY2E/OzyVr8zBJonMr2FhLKCoX4WLZJfDnYdbdkSceEyEsMOKoctatS8xmmNIyrIgvjCxnnmUflySuDBVbdR4jIZirZ9jrkUza+OYTzxVRTM/n7VxwCSNT5uiN3O8OmG1qlZfpL2HiBypn7zDOkRUeaJk0XeiLdO5qTbfRDxDacThfjvdd4fKKECAuUGzuDtex3mmrZd2Tn6jhGpYpig2XsFiOay6NEiLrjeVLTJakMvIoKdXOaSAfr9TfI4wwX1EKcQ92YqHyFWUPZs3h9VZlka4SDfVP8FZZl5psGKw1b2LvpS2Y3lkbIyzdaOnLqhru0GflnZcV04/jKeWbrpNc7POQcwpoKa9Z3GOvbjVfDKo1qzNd8CmSbNpQlBBpZaGbypsyuhHb1a2bX1CrWJjUJ7YmhacsraFhmqQNIRWNV3KlodNYEq4X4txjquGj1Q2gqun0HnbSjhP0GB60D5aeqZnrSJPlry1k7WVkVhEpr2dvkND4ap5XzajsDuUx5CbUbd9fKu+WV8r0WKmvpW2JKukgrc7nqk5VUPDm1lMpqRxTphMqyefe3xbSoq6XFOes7ctT8+mKcakrdaudV67PDEx3DnHcZCRW5CBiSfLVIisSZhvWrmpflZvczTIsZF/TEOdt62YrjVWeIeju890T01vkcd1Hj2/134+XccigocyeVWCzs+Htq0obl262qSzuY09U7E3NbuwUVmOz8NUbUVEe0gwqpS9VbYzrF1Jrp60iC6ImZ+ZlZgstlyEm6eZdM44qLy6sDhnP7+iiKlXy4/NgEmoxSZIkGgqTSWYJ4IppJ9MTuDBzWdNyLJ7vFQ6eVM/v0ZnvKqvmJLJlZljUHIzm26ulK40xriRfBRDet1WykNAnpBgULmx0zBrbI7TrV5FgEhvQNAhtb5yUolNVqIqVMGWqJexcpl7nGyIaqWgKU6SP0SWx29GiiRFnzxcZr3bQ1x6eKNsa8meSj1LWpA1XjW+v4qDiJZ1yqpyYKexvBtNii1zbU/YoRaoe8SNSS3OlDFzM2dccG6beWNNSzZeQ3PKIJO2eHd1SrDJr6Uits6sXYtnUG9EtSPDNz02saGpUlw2lElGt1HjRp5cyEGZy31VnXq0kXNRfZgkI4ekU8TEbqGanLuMMLZColK5bxxENkaCtSuhVj9lqlRhhYW0tVmxm2CKwVwwSh1KWJxFqJESskiMOHM9R7uTtMORuFy1ksdGsLLXsqzJlrSwfjFhN0aEt3RVqHWWxTFOcG5lRx1sv7FCbDxIpoxAYLMzsdttkbeuI668rxRoy4ON1slyRR+VeNOSXsZfOLyOOLomlobX1GXBhWoxcr+612q1ejS3xjFQm851wLi7ooV1vH6gT6KgPWqDr14jjoWU0nPRWTxJtoR2I87BT6e+pomDPZO/Y3VOZ4GmYmqJl392ML2bPE21QHh5WHZ+pYE3LVZYjGmBopSJO8PQYJvHtGmiapK0vJdKuJGEyzjHs36ukyekSO+m3KJ6i1wa0FdMfqTYX0nJalKgdVNQgW98sc0zWJ+hh30poLeBVhyUq804f4B8ZLONL0SV075TvM6oU0lf21bRPs6EZoa9er14jETTPzyBwUBESseKXL98vn/BgqdoMsfi1pSQXI3DlTKL5L/lYmpAsqZXsZrGN0DAl0JQYXLPzFtkhGuovi1yyla6M8J/bMmOw3dSXLqzu7Y0O1KaSD2p1aLISMe/n5lqtTwweW5ndMp7QkqhX9JvsSKiQZzM11w9T5ltWdExwbiPQpe/dm2vZW1xZplouY5aqcGKt2k7flYzbZeUsSiIj7K6pz1fqESoY215P5GAu7GP0cSij31xhJtkPpSi3GROnlOMZU1/s3lCl5lgw8q/vamdsa1kjZOySYtX0FhlbyhvsTM1qoZIYK9CT05cX0EkIqI3rWGtYG46p2sucNIxsrqlWz0+tMuVSzCkSYeigEhL3ctZeCqSLllixRxdxqqna1dCZz2uLmeoN5FBv1RffISRzHo31yzZLlZgjsyvLGY7OmvCSyl6h2O/djVVOkCxtp6noM1YPdKpdrpQMsJmn4wsS61GmNTUVclfNcLSeD9Ng25hapZ8NdlyvELIXstho1euP72EPK6jbliToJd7oTPPZmA2JoSws01NfVpte2WQuyQZJZFgvSQ1fK5pwKunK4xgZz+k5187cj+DHcYog72hf8U4xTjOOpVYT3CDa3edWnFxPbC+R5x4XcJuHiyqLJWQY3eoYJOWrziYu9c2YxxZlbSpUGfOMta1PEuZ1dVL05vClKqDVEpLdF8xb7AkJK+5nKXFRXNeiV0tS8x7QTFnx22bjDiTgJNhXKWczntHqKNG0qxHkmsxrWB6O1RRnHWvjbmWi4U2tVzHea6SsI+vwYxIoDXZRkCXw0M+SieakaLNkZufmSlZjGJKm4GLKcAinjdciVhrStnWhZu2vNB5XMJxy1Y7vptltretn1tPWnyQunF+WIy4xXRimtSnpV2pJMSbTLsniYpch7s2Y581hZqkzIKugkhebqe/dylCwBlBrFrOU3GVkI2Ht6S72TwnMmiTcZqdanbZRL/K0XdMOFgks49gMs3ALMSvtH9dvi6AzWFdaESJa8m/TFecVKeupU9a0XJ0Vsd7p2mwkbzIpTXQhpyfgZpOQzWut1SiM6Q5u8JQsaF0SdRCl5gxmWCZbXA2VEBInybGpDJqPi2OtmNg1LW0pb9XzzxuvYCrgsAiemFjPEJNta0nHKhuTDGCg1fSo1FqbFTJTo1kM5BZilMtzUbIzjxLoMyOqEA9in99qnhDadZxe8GAMIqGqsynPY1vKJ5U0XJbwq66c01rsD1vWLVxRp+4qpW6pVxgu75QgF48QmQ2aGd0oK6INkGvO5hcYj+3UKM5WZhPp8MwTaLFmEG4TE2aS36Auki4k+J8kWinQ3O4RC4uh0SBo2G+pFCWn4FZkTcyX1OhQXLBZScrpZpOQDNw3GSpwoBVHHUsMZ89Q6U/xai5QKFVRpxKamZ5hnZRgkeZsZeQOSjNqnSMkSduwbxMsB09yW9ztmdHO5yRk3wls1SEaVOqMxezUzuVw8CZkaxal2awi5qiyYBjNI5hhTSxizDQeNlCJMaVP2HBhW4xolNcKK5snakw3apwYjuHYr6ULUwxdTvZdI1nhsekkH6RlCtneGaxV5jCNyWKMk2AqK96O2kkc2uZTXMumXepwrW2dcI1Zbe0gEO4XrFaRD2pb0YlNWMpkbqazJ1cQTJ4VrlKjTbKN51Bh07FZEVauSq2fEIxynBvyYej1ay4xSasnSZqYL+FrpmqOZ27wjxJ4pCzUkVvtF6OhiAkgy2BbcaUs4OLqihUSZSrZW+8LTtoYm6gN3W6OD6zmV1NckGrP8Chz3SEgZex3nU9ZEgxa4OpgEgldbGAlSR2sshG0qQtT7tVt61sgKRMzFVKyTZql1c3kFF/m6Z6gTyXhia8wHduX5Z4QkxiaNKQl3VMeTnoOq4un1+aLstynYBWrnJBt4t3jUd5f40wN8aGua0sO3yGcaN2fI6+R165x96xjkOhTXSp0FVRnMhXo3jD1Z1mOoxjyL5uXEqCNT04zXSKVUmYprFc0K+eRUoco5OQTpOcUC7BMKtLvMVFMpV9VaBE0EuAz5dmqJXHTLnNybTFXqZjPWFKYa1LyL+LxJeNNT98dGCUteV76YpXf1FOmK45QZ02J2ZAyaSqMj8mhIBZcLSsdEFqa4SAPW9Ygk9OwaOGXDOIoIJaasRqYtMuJFugfD5O09M7NXx/cVR5YJY/mKdJNU1K3XOrWURkx9NFi85ueja4chzCqEZObkdOuqOtgohsS6JjqdhQolAuLb+tRJ87XGfCTkfFeI2Yj8+GKa9jVpxOFcy8K4epv5RAOo5rNzyPfYqkc7Cwnq5atpavoo1Pq8Y2RXZ8fCiHaHayptd9p2KNcCi4NYJ7xGa1noLCxnhit541sYGaP1Gq0m6boKKBy1CYJXahU5ueej9MZX5cjdQ2tDGSZTuidp7Qm2XZd6iEPmtJMcnBiE3JYNCMNiiVQc/JQLB0jVuSwmafuYllkihxdTJOT0XDsyujJji4M1SQX7VesFgJL8GZfLxAr8xDZRuxOU55vlzBa2xDcFA6RHzl5lnefrC3wKyIcDJWZE3CR2VAr9ichoq1Zom+xbg9OWCxcEhVwtOY0lSrKHKyJy7Uj1LIZW/Mwl2gLslGglc+LyfKn1a/JnSGYlcsw3a3x2eCxs5JVHx1jEeXyoE3a6uX2LEgo4ilZ6S0mFCHv2yOT1Gqx15BJJlmq5c5xZJ8ySitooKoYJCUa0CklZOmzKOHeUuGQS+ESoJ2l6Zek3PBkjbDPMOOLDiww3pkJEx0XGPQp7tUbohvqKZnMHRkeLKEtkm7QKt9jIVJhc0gfmeqstl6VbK8mlSzzSi5PrCwvT8Rt3GEMm3CSJ9wLZlaT2urdjohv2CmvX3OQmOF2IHBpGFneDGDQJeepFekeNqnO2aAUbtQT5lGXTYqoU65YUG8KMWSkltvL3JslLNbQH1taWVFk2AyyyjKmrZmpYCmm7aXwkSyTaRUK8S0p1mDPjlSuXmzXoTKUTl/Smt14F+8M5ePz6CuX8wnIcDAP2VhuYhIp6GJsWJFba8owmFvRHpekYwxj4FxM45LfEOIjzCTuMl/n4wfZDG4Nrhsf1BeVlJcqGGQgMRtsi5pMs2FP3SKYGZyRFzDj8hrc7PJqMgmNMi/0ZKIO3A2udRzn4SLaZ3Oz8upx7wtmKl5W8RCothmHbYzP3qop583VlFvOseprKK7s3tzMGmWNcG8zmnOj8NPbS0gmrG5Hr1KdIN5RtSU2WdDfD6KSrVALk2ndZ9R20lbdV6OW03BjW8zlNE4MoBBstBOccx2WmW4y2e1S+dIMo5JqLFtejjYL7ZQeDQ/iC1Su0OwmRy9qYmLktNPY9cqY5epdIh1UornXZRqj3E8x19AeWuUyp+Ymyt2sqV7RrSAhZBX3jJOZtqYZmp6dF1HPWC+kUp/UH9qdNuYvI2/wX1xJqXQeYlsU72tv3aqznOoZmdQgWXLzI2pzH6s0GVRQJtZkrjNQZBuO6zJSmiwN8zfTI0+qHpMNMFzmEOCJFxrqTHSQMiZkGF8tW1j1oTSIaS8r2+7aYWewIeuLX+vbNbm32aZaJNpNKpJN3N/fmRvkoCUXHo3vraUZ89yPEW4u2Jtn6U2l1ihJKmtp2nLS8sntp2uni1DVGGjdMRTn4pNfXigb1qIx3RbTIjMeKe7ejkqaadodX9Gb0O8WlDHVDguvDNAeWnHJXZJ5jtvj1eeXZO8jEmya1GUVRq7J85+w60xOrvdX1ZNqWySLVZGMacjp06ttsBBp1jUmXKCk7SUN8aUU4d0qT2zaaUzxG+7bKKnuo8ge2OeiKWyQE20dXCMa0OT6qZRqKiRJVKDv78oPh8uXpdStLh6etxoMr5ap73AgXpGh4dTQnfT1IqayTyY2DuDRUynPMLaOVrARlQ6f51Ip4SzS5fNyoB5xlhQSsuXTYI3c2G6nkA/a6l8j9ahiDFxuru/rljEXsJO3YFfN7JdUWdGsmtfbMvnrDcruLKxMb+YQod3ZbC1PriZpb2XZFpKn3aJlilOwq1QwEskNb6oo8MpM3U5hWpzdMVdaIFdqEEqqr+VYauSjT53UoYoisFhTFWAjlaGXFRBwn9EVmdF1ZF9lkFTnio+p5YxlHJajWC/gGR0vcCzp703W1s3a1aye8E8fTmzga9DwK8/L7/HTZ1ErIu2p3hbw29nSkNynmuWZ3yhVrfAosdlpttOW86EvorIbGZqt0uZtylqZL2TUhonkoSspIwpfWeRXK5FOn/Nnyq9dXu3pJB2G8pzhtWQnbNwyC6y26xCnFjPJ8CFzjvLjMjHdjK10bCyJ0K5oUutdaw0n085Ma7CpL2KvF46ss8zhhy7x1qidX9qTWwvxn92rUdMaJ1RmtGfcVi9brcquJCfmXtOxyuegLUTtszQhZVvsKmRwT+lTaN6yrk7N1lgQNd8f8gsimcqhoy9Mk+Br8RZcb2KOX80rj5OpLNdJ9dNrz+zh8RpfZqqrrtCoyYwhX00ppmyymtNMox9mkB82Cp3OXlBu2HJu0NWunVbXMe9QoVgWZrkeT9wZ6/Pz5orVtZNuJzRLEI5WrY8plK4faOUvjKzRrZUcbuFH7dXb5hORLgroTxWUqupYIiNmNQrV3RmdLRnvIyJqIhzd6NDbFJ2JIO2hkGsWVNrYtOFO9rZP49UUYdmrk5lbH4jlI6ftlZ0woG/pTlLNl9hHSWVHWCbiyaTkRyJlcFIuk3OenFxr1jF1kuipNyPQmC+2yVSxX98MkeqrNuLri9izXRj5YZo1myeV8LESsu4slF8rZ1UdjeMrqRPpoZY1lMsxox3bHIhcExChyowRT1Uj6MnKMLFi7x7LsFTqC+6i3XHUKFku36hpm5+LqVgVmqmNKy8b1KAvVNbU4yZNNHao3A5RXpCunRPY97NLi3DS4iTk3tLu1tczW5Hz2jPT25mgEMqS8erX2ngPtR6jVtQQ61O2dpmJnqgRb+jcl2PZjJ4TKmoe0vAMjp0MUqZQo+YREwwvL7M2nzMfDBeV0togkEwXXGOps9iPEEmp7WyjTlYj3hC2cSYQKlkLoG9uM+JsJJvrkB0zN9+bJNIM1GzcrUmwreZOY9Ndo1Qg5JTcTzdst1KV4lYjajDcrW+pqCyemVyoCYqnJTIoKmDOD86u73NsGJHOjp8LlGAJKY1vkLJbmSCPF2nlzjHdS3Dd5KTbU2+o5l9kp5jWZOCxqaQeHGPbZQ2lnVm4rs8b45Zil7D0WCGyVDHPTzOaEVu1Ia/00Fur3GCv4Q3NLzEcLFKsIaWP2w8OYxDc3VjfLy9a7JZNoylmZVtdZMohouXSKo7YWEgMcd7xDjHlImE0dJCx52+ekSCRI+TrkCOSzefo2iJR2WO0WDNYXysWZmyzYnCuo4YubaJhHWUJ0zCvMSoJpNWlb2wyUFBk2ipUVpltd5dtWcwjDJ6Wb65MpDMKjZSTLJgQph6zEpBMlNtzmNsoElLQNOkT8V0Ljh/gYVLQn2LaWqmrroYRKSnpJSGm4mCe8U3VW3EpyG7aFA/Wr8fxI1cL6aJhyCjrqA0q1aoTaqtqTNbiDTHkJCeJkfCh+d7TTitfV2abDw9RbnKUa2dZWOOuFaodHm2WoVXVklRgIDVpcpFqb1wfESIuGZ4lI+nP5qDNanLfXVrSCVcYV6rTrxEn4RFOZwdjGPMfJnBhrqtWkWlVY1YrVFBP2KF1zeOl27O1qxtbMlJdLrFYmxCxKuxV2eYwz7jcUWkTSyupZ4nq25BmjGuOLM/yJJ4rImKJiq1YsgzfrAif8excY1dZ6GAxYvaREjXWXSiPLeDcyZum4uZHswpn0DFxHWuOYBooiakqmhD0bkolsSKcHedmlPLgc5anUJIqBqXqbFyiqB9Q0yfEaGSIFFNNUiDE450mqpRr3NOtbE9TGU3ebdqQ2RmY45an2DFXD1c0Mlfhj4tdsBss1hCx4l+fU4+kp59XGjXi3zTj5xlv6KJdH+2kbcru7xzrXWXdHhUdBqMmpnCOTe5SlGXIGU0KG5MsLc+X303VlKvbFB1SqLTfZq6KINVqGhHoXRTQFS6doV0n7e+YrMgrZ8ko6kjjw1ih46foz5pTDirKYqroSZpPbE3sIuETZidz3Q9YzdHqritfdGMVleza1el1ny/s2FrUdPFzW9WqUN4gyyty4DXn1Jfm59ZUop7b8swvHiHc9I0mrrMWHlgd4MyIG1fQLO0qVo3T0RMriQvfJw3dKHegnaEkkJIXrVexCB8WmSwVZ5ylD2EV8JnhMPSg7hW2KmAS7xe0TZqRG5FL8U5cI3Cr2JpvkmDTKqoKk01hpMzrXtMxC0/w42hjZh9iVxmyn6epZ3XLTijz8IbiL2SvqGuIZdZTqhtY1Q6aYjNWTFotnTWkHxjykKuSWZAl0pKo72JV87Ie2/kRJpMioBxspKdNasuMbNFUsjCPm0xm1M6o8FvhFaxTysfY68ydbkqupo0bX1emTijemdIYZmKd9EjcX1GpFzEprhpkkiRX59ziGlFy0Q2WlLByaTHNYayw70zVWxHxEo0hZmBU7xnpD1unyRIPZBZv7alsoWyqpcruGWbwJOiGFSle05lgmG3yJt5a6U6ZjtZyJ9LYYBoWzBkNNaPSJJBLrqlcjuNS1x6ynSmRLpek3Q/635/dK65cIUsT6ZoSHyvzR28yIbAlGSIxU08z26Ht6yZwXzGq4eiZU5TT6KyOZGmPrCyauKXuNGDM1C+y5tesoZMerKLNc0rpnGahbxFiLOQWlWju4VYl6ODJn9MdluKp3qPPXChi2PCittfVlk+zDW2ZHdpiItebU2ma8R/fL1kOIuMOkZThqOmcJWSgHavWTTTejs53WvJlnx60WurlYiniZljs8FDinXLXqKsV084VqavoZeou0C8pp92vpOwjja7IR++L5xnp9lHQs7CuzYqzrGwfGCrLytORJSFtoorz14tl0ZzeU4rSGaTQlXlaGOqk2KuEVJos6TXM0BRc8ZfcaNYf7d6vzeedIswjiYgUG1YLKpIbSzExbRSQ0VDxm6szbaCdz7CbZaGvpTGxB5atr1/VGhfqb8tb52OcHVmd4vBfDF8tGaXW5AuiME0Yz6xujw5d8uVbWmRobxMfaepamOGiseNOUevgl4/uGNzxL2oOs9FWsl2n5kxx1hXaGTHs0RZ0cAqiTenLXKxqJyBErWOrL0yfbtWyJcov4lqwoY4O6Q4iKU/4UPArj/EgJNKK9BjeF6iPiKprraMQD8YmrW4lWyas6p8klBlssg1qdO8kXxPrU1xtGOcb5xXYcNkv1Z6X8mMoldChdBeYYIzvCp/n2Cm0EjHKnl/gVh/RMVUYnZNQrkqKzdEnJN0NGBbjbEVYE1uwHyUc5HJSaRYuMYrqIvXukquPcYxfGxhV5+INFuEhYHSMmxdV7c7QynQSa45dTpeRGjSpkyyL5aCV6K6emyDjWOwU9Rhi2Ans8d7kzZmt8k8L4OGP8GSPsxzm8DKbktygpCRm2NeK5VppXbTsSxJwoJlTTNjoc+WYbY3RzxcenBkrDVycShXeV9mOkvUaUKJuZGsbZ1guYVmPFmyiqHCvolEWn2XhKGTkr4wpHiWrGVhvVevQHONhXtYQ7gkfLGWr3hbzFlrez2Knp+vWVpozFxul8u6wknNi3uuTF61YWp+0FZggpeObnKmcWPJUMhiV6t/u0+leG9wM761gnbNrT2XjYS5U2fJVE94UCa9oyN1OF2/ekuZUoK5xDrDSL53n2Z2Xo6OY9PQVUDKnWUftzKAPTzTtki83IRBvGa9aWxLlI5Knm+Jq7cnRY5lhrRzdlRuVJ6UctJwtbpLxlo0loqHh7qGPDykSVHCeJJVwrx+2mVImKhsYYOdr2h/biTIhppobHJnMZIr1EeSn2iLUj6wOksxbK3AQ0fayZy0mpqYbm1ebcVqthcvn6E0mC9BviCxtEKuRJlgTXAoHq5oxE9HcaeiV3MztoVgOZJWRpR5vsVlQNCcM1N6sT9usnOxty/AOZpHi0I85b9kxlhlkIrN1pecQFK1u4hVLA26srg4kIVqbIOgoMZjL4uBSDikZY+iKGTDoKqWzkt7e5VmYEzF23KlZOA1SJZ/v4ZsfIZcb8gyW7VUWFxvx8S1p4giXI47xGeNxmd0mX1vI1JHWIjLwzVZpFJMfKA9p46rQm7CkaCdaKfLfjY/nm2F1D2qMzzGXZA8RdnXt6Vi3bC7OXrEb8WehaaeqD5G38Kmbnw5bp5bVozgvTyrUo8frnBbamgYsrSJoDU2upRDqo9uiJJYVKfhNUFdwXBmI85oicc9Gipchsh1pdmBY11BsU6GqLxSLzh4nE/DS2CKdq+hZ39twpxPc5yHY4m/oSrCSoMuochdj5TEG5+PfLjEvsU5O7GkZDdp3S91RyjNK1+Z0Y5rK8Z1YWTAi6g4qSRyzZpVeXhmWV5RR0+NVoLOpbxCMKrMdTorxC9vSjCVs07GfSlGRbZ1PaeMOXOQQLSinbQsYcGEyoSDbChtlJ9szj54ickrUEadym/IjHgvZz85sY9ybI5LYFxIpFJPMGxXqM7FzK1df8DIsWtiMcF1b5S4aGylyqRBkb9f2EWyX4ObxMohwq1LUyWRvGimyKp9ZHm6ZDmHeW29o0TSb7yoVnqQt5B/t4aPuGHFmLiHhsm6pKojLJZdcrJot9Bwg9dLlGtvfmFzgIzYw7XGkjYgwbSWa5vVS2ZnbmsslGlVe7CtsMyaTL8nQELHpnAuitNqVMpoz17JanahgplgqEh5P8yba71vUm7TrGquu8ZWsXO7dlxFUIU9YLjarXdWcskxsS7Of0Zin1aiyku3c1B7unzMRpeZN+N7uaHaXZlFXkdLgbErXD69Y6ovipzFvHe707tT1jpVRbVkfZ5aS0ts2k9Wj2DIIDgdrUe6PDrQV711H0inxGJcsWdvaYjRfHc0qEjBa5OqZKSXrli9yrVfKE3JVEpNUMDcwXCpbM22RJSVw5Serqc0P3CXxjk5aoa5MrZyjK2ChEuTtE9i171FRSO41GJXWkxuwsgsKjs4sj+tNZOdUmbBwmO7E8FFirZScJ9LMoqL15t1TMPAyVKMRX6DeWyIPkdzyqlFPzvLr35gdG1VwKd/341IfzFAyba9U25XfVKsxmLZMYPKTntpoUJB08dqbjUti6eLen9rnnl7tH+FPZpykEJ8VVScsj2cO0p2pV2zpqOLsceJiqR8eHlVYOJtTkXOrYMplagpZWWyXb5Zq4o9MIGjWJQ3pnmciEqKZ5q3Pq2lczDNGSY2RIOmxJy3do/Ca5SvJ71GTnRvT8NDZoYs0EY7MJsiuAl5v7y6h8cqJCd3taVsrVd0p3onhryHsV8+0tZEz0wlfkqdTG2MVLIstNJhNHUtfZDAcV2bdlLIjqBNq2FSscK2bSNpjopKTm2xg59XIUO54XA/a1BUvzWnnnCTQbYwUnxkNaJQWYVOUNl1PFM3wjCSxo84qqqEjWNe0ThbOElEvTB2x82oo2JNV4Keb3LDvo92kFCfZa9WLsWNpzVB08RgI3NbubMyRKFPHp1gUKdUYihSa1RL5ciHaVJ/Uq3VbHpINaC0fZPNj7Aqz2mANUdPT4tCqipePJGJWGPmmL7CqW4Xk0WJTiEaNqvJXYi5ijSexnI/g8BpZI9D01dZSD22plDBtSt0sM97OqNid1HIjKjQ20Zu0zqduIG8e95Un5ecuEeLX247tuDQLH9jtc+3V6PQoEhtNdFNQlqbp7pGdo60eTpGb9F1oXIvxJiZVU+qj0rd0WaoQ4y1v2tBWU5gNslsqJlEcoddsH+Gr2RmMst5Woe8a0OxLY+Ux3xKJ5S9bZ+Tr6WptLyAg8NnrYGje3lUTYHHvTvKso+jgz1WOzetYIqEgWNRkyBdaK6AS3RAgGNibYpZL6+wQMeKxMxkW0NYPGRbJ2OvM4CxxqOQUG2ivzJTRMp+hVa1JndrFsa0XUFXkyhmg2+WkVu9SrLVYX7avqtErTyCsaRjkrGNdV2CJkSgln5AuEO0Xz+0jHxNxllNprPLLl03r3rBhn5aOcrZTMA+M6u4j1Y7Oi4nKJp4QHBKXK2mRc7Qq6vQTipuVKxTvoh6UE9gUXVBX5ZjoZOnm4Bqmi97b2K5aEbYrlI2f33MO1YzjEWrjU5IxTVBkIyKZMPQvDtBg51k3E5CRmC6ZU6S0r19fpSpkUuRZmu4lbZ1LY5KSzpL1IPCapmImaacyTFptbjAxTA1f1iAwS0ycVA6kXZ8tXFbXmSOqYhaSGQxjbN6go/WwJ5lwzbMu7lbfDuaJ4KSUomnWUhhL5F3l6K7cYKPXUNnhkA1w3WdTILZYshRhUDDxmJcqWFve5OiOYfHdDPfc0XAS6Z9SIqJkG1qilA9cH9tTZA8ooTQYIp0TVN1Oti5sLBeU6+GmDhWOr3Qm8lUl7x6mKxIMltbO0C9oSu+c0xluos1btZEsHNkpmKPpnYhw12vx9l0g3lQkatNnl6wNamStlEyy1VPRECrgo9IPUSDo0XQqE6GumZlU8N8jppRmmpszFczrap9o4+FWGs/mb+UzVPQoazQfaS+rnyjfii8IStuqsNE0KLpdWrMojiswmOniJlgT6OuY15NzTXEnFdOMb2vL3fZuja+c8hrkJ2Ur4edl3tHK7JwX7txa8JErK6adUp3TY2ASJ2Zo6fYWlyiNDXDR60tZqekjrawpXeNjiuFO3B1skqsqzMfwJiboDqGqp1YVrWMPUiFfciUULmrqXGwqWLaenhMcEN1clkpw1SS2HTLt1F4M37Cj8zFdNFca0J7f6N+M2F4VsiXO7e+QMRKN9pZr3dvWk63eZd8kMbRZDipu02wU312paCA6X5Er2lHsZ3AULdAVIuFQTqccmhhsWxIdYnV2YqQKGh3pyG0R6q/dzBylZ2UgrE6sKvBRMRMdM+XcszVbj2iQp6nMY8q22NCQEJhYEvEcStpirTMNq45usqHycitJ842O9puWD/HlWNEWaPUaoVnabjMTUXFL3mkZpdIdKlnciKovrBANlQ5u4K6rnabfWDBW3OYZmApVilhxsSlbIlQOZFVPGa7GnnKsm+owUu7OWhTX6BDSUF2epZrQ0JIdUxdZpc1PXjGc3xX35p6aCZ3jMiAYn20XUi9T2WFabIdbIm6vqOGNaG4nHDQh25lTsp9sWyNdsGxykzExEWuxnyuzFBRqN5Wn1NwZrpbIHoyjyq4SGOrO052Iph7v7HOaz5VMb4VlZuIgs1KVmxBiX+soCVyWXHEoIWziIgybMjOU0svd1xQuKbElVLBYMg+c7qBgX1shELPj95cUj5YK1B/uYetQKZtn1DJnKa3YKBAgYVPOoFEcDG+op3HX0V+O5Gf3L1yplRdxrovLkOiTzc/gHKvboN3NEm8uZ5IncpKfoUqiGCkSl3CtVzPbEuhQyBetb3Gsmo/wMY7fzp4PbKMtVFbmTRM0NE7xEV9nIlVeTROSpXfXUtevM0txbBznV2HX8cwf56ftYykiNSJwj6zaniSoJ1bLliv2VuZRz44Z7VE5582iS/VIY6oTFmGcI2XW2fQTLZyT0ZNsYpizDnGZI84JMA0JKqpbawljLGof3O7ROFpNnGZRLfKb5l1P5VRlb+7NoDAtreto9ah01BvP5u+g4dF0zNNVGSIPcSVtdFCNEO9Q9rPo1OwPuLK4lEkMMqMvbk1LdQ31XUmNIwnkkuynq99kDfDPGwko1s9REmdfqCAeZWbplU2epF1f0gywriDj1CIamjGYn1aoNUtXKR1X8/Ou4ujcn1OnHCod95hJ5GKvSbUmjpauIJRn7ZcYMJgO1dou5JxLZyHomp+SpB0JJBVM241TmZhkHuQlzFwWIyUXbkmPdLAWKerUF5aoohtt2ZldXJ1SpbLjWedi6Eue3wr0cArLGg1ZmlCw36iRFuVaS0bdodWjWNVOc2abbXJkj3PtD2OOFDLo213iWCczpk5dVeTQparuIlkj2V1jmLNLXVcd64/sqCZV1m5TDW2yHBpRju5Sn2PIj+uiD+Rlld4dEU0qi6mOJabulRnSrmKnjGl0aHEyihBzcSqc9JRX6UquXaWixaYMmx1zK1IZ8K7jjFT2X2Duo+GgSU2n3FAt7fKOsPHmqw8grNQhWd1RHiDaro7PKaqa6Zv1Ns6ZU9m4GBwnE82aL5pNnmQT0GwvsY9blJWZ5xeWcQ2i9KnXm9dgTKbeXaskDp3cIqzZl5barmGUZFvT2inIimzLc+uManYc1Qxp8soKZTGez7M0ZijY7AgU2dbYEh4H2SWrcGswm5ux4XKSotCm2HDLruHxL9Jzz1yS3RhV5TEJDFNo8GbkU5NtWJskWauJHKxn3RMsbONjtqkg0CUd25JNa6SkGy51yaSPIigX2DRS1lXoLp6ja5SnLJCV+OKZLZg0W+8U32rM5uOIoW2xV5SpTizTFxsdR55b6VQV7IviHO8Si5xuYSMb5q8mVjDuI0tmqyRWLabN4SqxXgqvHWgp4iPqFCCyztluqKZR39QL066jdF/OJh7Zsk5dk7SiaRTUZQle0KK0ZdoYZiFcLCOpmSPNJVqtEJ+yXospm9VPd/GwJ2DRckp1KljSNIkWMaKvJmbhmpFk9FcuFGxh75NsqCfkVdiQYtbYYo8aLJKk17UhStsXr1Vk05WvKKLJkN5VqSBbHVnZWWBznVFU65yTaOJ0XhcSkeEzKo3yb2mnsxgfau8ZLLGQncqSZCFeIGSgXWixy7MM5gqvl04O3VbVbV3ZJK7pSRVRWdhuDBcaE2ORLRcim5qTM6/fqu+U1taZJWVUFhzhzypjHKWsLV/J3WBXVQ03GArLmC9wNeWbYpg2Je6V398bkK/hYnHIMaFYW7QcFO9e5F4vbe7cyN/mjpYO8e6snZzcUltqExIppG0s8OHokmaOcNOYnq8zaZPPSuFM7XPZYBjVc2ytJe/cnI/kqWpmF3EkauKhqgoen0uUzo6czi+tkFxy0yZZLerK5w1vznRVqqGjzyBy7WqTsJhQNZZwUK/vbKmUHRzH8ibaDnRMi1Kni2rZ5tRpUaTLlJ+pbQqhL5qtJTJNqerqGM1Znh3IpspsKyvcqqulFkvYNNwOklE0X1jv8Yqs1bAybdTTbMysaRtYGWqXnd2o5bGQaqWHlJ8yqJErkS3YE9u1cVGW9C54Vt9mVtpaMBkqTdaxjOX0qK4cUSRc73BbGNiTIB9gNCLPnRDU1TFk8zGLDRZYH2bfR5DaMmEa0F3QZSM0NAgT4M6UdZ5p3c+RJC906hawDOOlLV5YpV5RKwumbe2O6Rf1ktZc2dre8AuJ6ijeC4niY+uOWSfmH9hk7avH4UkjLHKjUxVfseoh7uJZy/AU1rKQY+guXubbUXBapfDp5FFnjulPKNYVXBHpDB9YIO0RM10vUlQXGySQ4uMo6Nal5tap2stu5uvilq5O8WhiViXhIxpZ83KiaOyYUWWPUuVdSclvkXIQEXPqLyrJjy0jdKGR6IzK8JCoK2Wz5GAYmLPNbqixz6Fs488OaB+y6J7vUifTcePl6p9HFKrNLpOSoybjr1HXbUVeoavVoBTck/NoUqzf5dYs2ZKOLl8kEM1dc1+kdIovNd/L5y8aZxgQ3SRyDgtfGwlrDI3YM9+Zl0qd7dLIMk7mdGYK87Cn5Y9dodioD5jNNBATqp9W1u2NWhha9+JUSxaXWY7fE++QzpJYYC1gLw6L8QipGU4z4h1xllnWGpFcblaq6A8o8R0u0SApr21Z8JPfUCdccFhe5suhV8ZlmqgMmWgpqybp2bMepqTZ2ZnuauMpkJ31H9Nra9Jt54/uHqZN41OL4KidVzMKLpUvkHNUF88gKxrQzSncKRIoMxaLipTI07OkbedYLJcTkeLv0uZnHI0xp69O4xTxI28hKuZrm2wZ55QpTGkv658JlDOI2Xb33g+SSqMzst7nUNzaGCnnNdPYzObQnQxhaJGZqjdgjWwUXqOdbitO3vWmkdOcmlmec5BvEUtWYK0lpKmziqNIDKoq5mKx8OKNbi3iiDI1ZzUiVKUadbVTKxppJ1XW0JMfFBzR7FZ2T/DW4c7e2A6xcBbydJdKHFZWrDTnr620Dsr2ztGQoRrK7WAxLV2lDNxYGpoYqe+hpu2SrZ3W82ayMhKbqucWLTYMrxVZ3JHbd9W2HopoqJVjFlOw3bDOKq8d5t6qC60VX5JN7mEiD5Bg7dSwlR9MoTPNai2dUGAvXigsWtBqU6cK4eMVF7CO2+CXJ9sW8ZYZGAnq8Q/xHy6z0Bxo2mekW6WSaan2m9zR6tOsWVkyFiga4MvjDK3wq9MkYhcJmOmUZ6tS7PITIymIq1oYpvVh2stXamaasssNqptajteVDpcpcY2XcRqvCijuHi2x1ZrtUZSk39Oe1RSyqO7Y9BVZnIxdHZnhn65pXOWobdLWkTfZS9HZsm5sbhIosU7X1N+zKZvxVa+JVJjV3CPoD9YmrHmRz6JwdQ9alZkx2vHSsmUPW1wlsBga4SYb3RWjEKVwamrJ7g5IIzZTGS4lkdrL6mgMbwsX5Zbna2yLt07XliZMj46k146jL+idIfXmo+g0mh2vGpxjkqUWFhY1ia3tVfEVdO9ZpMxQTRj0zCIKI8tQ3Kx1rjPTUGyMWdaXnG0xVycPIIui5TENje+RJOAZSOPglZfsXHJpy6hTza7iaa1sK8vhKFjfIohwlpvZbV7G7yhOLsflDS2PimBO0/ANmBCRkuwKb5iwJJrNFx8Y53ijyqzmq+beZB7a7InoaeHmKC8MEWnRHwzhUliWcsueKU9eEqXiVm6495KmlyPiJpeuDOkvGDEU1tuvS9NTs27wqFGf8lPpDV+rNFsj2cxYlhnuF+NRm5rnxdTUGKiyq7HxHW1bcorgn9BQVOnTKUsKqRwSJktIoaHOZl1n5iEwkk/lGtbiLzEVY9oxIKBuGWpsaJfPLVJy5ydy0aoPFWolyezWb5uVZqNes2RbKZHytyjooxhzkiZo4aYyiW0yEizu6JaPmMuZZm7zDZJ025QQDfPmDOooJiLwXxbodZMpi5tMq6QzGaLYjyCky9npECYfaCfg2U9iaxifd9B1XCGl3NDfyAjm4PFUsOyt1E/NuU9O1lnK19VT2aMyH99KdLLlHK1qLyIh495R1oqPYfLvWppPJeaRWpvVERERIK9Wlawt3Bkh3DW4pPcv0WKQGA6SG4YkKEwQa9YVYd5KLuapDCXnY8sl5K2fs5EUmabiGWMkZ6du1NbjLBbhoNAmTcrti6DuH6tYj5fUznaLHS3dkFOn1meYD9dzc59UmmVv2aW11iZRUW8aGHPx8A9qF6iNb7MzJ6/Y72jd0PDu60vfs+na7ZCndyFPGtAkMKYuKdYW5WYkYkxXYqUiKKgQX8YU0BdM5kogrlqLFaUsdpLa33ENY1sy3GWmqCkpX1YMjmxO8DHgZiuTX5ZdyqjM8SvY2BfPM2ewouDXL95f0OJmoQpdlVxX7GzXZliW0G2QJ+NOnNATYCUkjJhjSO535ZZth9akmaxWXtedIibM3I8Qzqfbs1Xq0WrXaOKecUkd59aYCm6qHNEO3bIxEpnkMNkdW96nKS2oISriZV3orW6fSl8b2FaN6OgqTDARMk2W6wnr5lcOoNbW02ePDwwh4+RSK8sbW0sKKGlYUS/2GY5V7DbYEiCiq6uf0a4uFxMdzfEur3Q0To7Y5+Qspl4hnbPv6lSoTx4sZm9jKC4LsyHw7miuWs8sE53oUjDw5GkdsuvyX2eObVCjLVMep5pPjyawbW9wK2XSS9OXcSMWlN7yl3ijGmxmjWnu3ReeabCY2u0olFCuay1Z2OKlKZjYUBQTLNSzm4usot8V0/Dp2mwspZoflhoZ7tIVUDatVvMU7HFxMc+k0O30kG4h9XQr4A6Mz8yYr65sGaRImeyc5XilGPTX29laJqdXXqWfWlGZpt/rFpdclW4UJOrt8u40oiaVZ6deZbWdInPyIDJnr/GNi2bm7uSWnmKMFzKR59si74yc4axR040PX1rnazAz0lHRoa9XDF6xXCUqJRQPFyeshpAi7TKimLInmVnhD6Ep560rKCmQJNnqDRJnm463Mm3u3GmOIbNjNazur0uR8vWUr7HPivPKIu6sqqeP9WkX0ydW8CBuCmaljd12JqfbX6hl4GpmTq7NGeeY25wYC0rwEtWXoZtSphyIl7Aya9kNDajjoxLoH1tOVauUmaa3bqsysVpgj+rroK+P0ddKzKYcrZxY75cKj7MvVakZ2c2jWeGYnJ7SpRVMDCGaRIktpUlwJpXrk9Ipm2rGKJqq5WZlZBRrjx1pl90eOliUcizfk26tF96fkV9eGtLWWF1X1FUV1Z3goC+cktBcXvFTItpRUhDb8GkZiu/hpI2J1NhLaAskrwpUTF5jaGRUIiuI16ypieVG6uvbKrDRnqstEc0mkOGamx2kLgqzFfCTJZ3mUyghbxxvq5pbZhHXbOoIkNr0mPGtCcwMyImyHWbnrZHdTQ7lVuhoma1lp+7Tra+a6U2M6igjK/CuYQ/ioNldEpjPCc+dcS8RklPdsKDT0+ohK28bLXDioiag3Qnyy+ektitlF2kv8NQL5OYzapimF1eSkxer8DEwxYhj22XVHA3IrRunkhSmV2PljvVbDhFV5SSjFE7amizPkVReZigTkuhWKlQc4iMeEnQfjaqOIJ6NMDDi18wuYCVXV58KVZdaE9pW1Ohw9s0dS2vl8AlzlCIbnnGMq+F01AzdcAcPR21oM5XdX/AI7uSu0R8wr5vL7ObxU47pyWPtkpCP0VkS0qPvI08Oj86xU1gn2KCTWeNuWAuiTpVocZpNoliP86zd2O2nWybUzanZcu1kMdfos5viI1Lws3BoaxNvSUcTrwueV+vp3mSo1eChsesbKw1bXGvisSeYGs8e2WBJcicoruBuGe3VnHVOzS4qpyVeoxSdr3BRH97e6FcqJyAlTOxn46WgX+jp2SLbozEU1rJXzHOPEVicqSnqlGAUuFIhEmo2G0xp1fEn2OMauCOPdR+TXJTxUm5SyFVqyWbpVdDqITJiB4koJl9u7dCpqlZu3fSRcBgq4qHI7aWV5lwxk+6hkw5v52tRMYxyYmOhDh9jCtpZ4xhTkvKQFSfwj9Pyc9lZYKDiKA8rYx+lUZLv1CJmMtynl/C0qomdIe8VZwlQl1JtH9ZYDXDSR+sdELTxWCCd3uPX2G6akygr1HEV2h3yz2ApFMkr8x2cF1otjhpfpS9Zk+eIH+bX6e/XNS7q0aFeUJRTEmlsnuRH8QpiNp5mI9Cya95RoV1YpZajzqP1oaDs7C8sYGMwFBMZnpXabxRYXN2hbdgpaJYVtRZXpykRUphjB4yfbO7JcK2bTS9lDNvmLwbT0yrV2fM0pd9LdJcX5FXVtZVSI4myZq6bS2rNEaZhHd8eq5VhmSi0D6xoszDeIg7eqwnkYjIxMxDMlFgsrfCfoEkIK1tvbk2jI6XNL1Cp19tsdC8elIonUpakExa0CzQlUOMgoK7zIjGclGyLaSsN6W4yIc6P056kEhugKeHV92VtCmiar5HmKOqqViOnjubY4mNXUFieU1+vDaCXzVxbbOOTMZrj88+yKSkWxYbnZ3GjsSxRJurSMKeepLR3ULn5KpuxImnU5jIrSA0oMTLaMZNl0zKPIuMR4+OlZbOfkKzUqtqU0FgtrE+ObGBQ9JmsrGOk8WDdqxYfErmU5BwO7yqiHRCpq+nx7G1wCmTwlG5YUgwoRmgfm5Wc6zPZcKuVimUjKFoK7hASKSWnztqXqeFWkO2Yalwd7kznJ6xmozAiHlTnx90v0AyvC+WScdXUz9owoOSXLORpGZuTXBGfppss610p3e0xX8deZB5r557U2JjukWJjzvCWh1Qr5GlIWiOEkjOsYI0eYCigNCtr82NWzR3fnZAjs5xWUBcTpNXwzZXcCVOV3NDP07TUKZ/MjyWJm63oDlNbFdFM8tdXbFNrFUtfLS+bzaWpnFMe1tEeThy1DvRSb+bX1NBlGJec6y3MoKQZaBPz3C0mi1grsxGUYc9ssejQFKwK7wzhoohprx2n40jRrW1fMzCabzWQ33XQmKqlyxIw6h+SsObNjRFZryawriLlJV5YChyRNhQr2/PLk7Lmau3YCkiVVC2jVQUN6OWyox+rDlyvV62R244jnpBK8R7zodyzkDXqElQZ4uAeUvaaFhLaN/QnKxFdHIuPag8kW+pt7qcdGukOI8wMCy7xbawPs9Ls39xu6R3n6vRxpBzwFrWx3w4cZxlPVTexYxhbdNge31Yb46QVrdpPjKPtoaNLiRdbzPGO4g8TohDn6yjNc5WJ4kpOr2juEqwi4bHQ39ZoFSXY2uosMK9WGo5z45PgI+viah2dDRcRL+4ZVRBr0CpWLm4qqy/M2hbYld6f2M7HUymph9xVVisuLurllc/mFczpaCks3ZmtWuchXU5lX22q1edMrh3UjxOP4ZW2IJSY0FFx16ggqon0WKLtnSkkEwzUHlBTGGfmS85O1+gv66nqnp+Rj58laLUgDIcuCYZoZRVkbGsUFBprHM3J3/XfzQsicW6s6KSPLkuZJKQq7QvdzXUIJyPniPQYT2Gl3eg0tBwVDxG1jFWx85+rEZmPL2utCvdpmTb1mE4Qc+5k0F9gH6DsiK7m3WtmJQgdZjLiq3RklB2psCaOKlr0I5rflqkgNmPYY6Zk0GsdZN/aZNCULswpr6WzGGdQ0YntKYqibqse8Ofk4RKzZC0XzCwqXddUaNasGuIiE3LN3mJZXqe76heYptOiZonM5WCkneixUoZf7CrnXHSSIe4vRhhHpg3RG27smNEhYCHJ1Z4Wj9neqmGWVFYlZXPa29Vl6iHPFFlabrGWr4kvjDFmEa0T29nhDZSpYRGpL2MRbZGdUGpgJHBlrVXd75tLJKfgiHPVEgyx1Eoiq5LlztMM7pkeYBkX7jQsF0zMVuClI5VlJAwmCd3ozasaSiNysbBka94wmSxXc+geHdHLL69JVaanNNeeLHCa31SLcVeWMRCloe0h0NMb3lWcFHBqjGn2FlIzT+VPpuwhLwhRCStlb5bdjg2x5HEkVWL0FiNuENYl2lYhZ3FJqBDqEiKgLu3j1yVwztsfC+pQzuWt1TRtDA2MUp5o8tCpalSVtyDXNqYPZpVXs0iWFGyw0mct6JOmie9OrHBncSiwbmrsUNwYq1Zw5tdHMJwP16mOdJrbcSHm6nDedZQPH52sZXPwXKrpJI0sJHGfqFeTzGzoXSjujJnfHtjqoqbJozAcCihey5gbmivVYAmdcszucpDcZA9UJJTqEFG2KlqScTayjCSr8ApicDDMt2tPmKLQLxgKpPHtb9dr0nMMZFXWGx7gFOamHpdoTXDYTazxNVdkdBAiWw+Zj3PmsKIVbKeSnWhWb5IjtdtZpUwxSNrkHzIb4w7LCSEeo9NoHZFVsKSWlKBREeawVBaYj/F1YAyWrFNkyMry4kviGhjV5CFmqcoQWGlo7LJe22Hu6iCqqp/r8t7nTafy8XAl7k7ia9fyzTOk5PXfmB1rJ1x2JEzMpKVZ3OMQFlWRDyYNZ00Zyk50p3JjJEwn1h0K3E9JlTAh2NdJ6hNUZBOWrdoJ2evXaZqTDWYiZuz2zo3zzKUrMx2aFiOcnY/nXK2fZOLv1JIScE+LC0tXIRaanJHYmpC3EKxxFyUuzpCnZLajFhNOkV2JtKlOZ2Qdj9PZsV8opyMo59di4nCjINBqbM5ZnxWZjPMdVKVoUhCjTZbWWI6zEJFuqyr5XqmcJoxmkDAwHeMNXY7lDmPxZ6TVWrHUZ+GXC1jzXhsV7h5NJFmNXHrbFRymnyciMdQXnJor5rBaSx6gIORYVRdpZe3nDlDwrdmZr45XnVKvGdoViaOdo20poBwxjBOoZaoHqixxECuNaWcpTC9j9FojmCBoX5wwo6CpRkmr3yhkp66TsWvUM02vns1gIGtmq1Fel7PK6xbb5F6dsw/sjTAcD+z07MtiEqBw4ycP2SeT29Xa0GK00p/TsBXw5fCUUmtaTSUQTopiZS2xDeC14hcekl8e7xBUbdAo1NVXzG8SotknKddK32ZbE3SkbzJQXvXhGM0uY5ofS1Eb57RQ5vOxKy4NmhdToB/6FEvqlF+qd2/UEmUWU2UlcKPwbtrgTHGqFGaQpY+s71mNbk0xxwhVTGdgmcYt5G3WXylkriCv2yaMrialKGrqTy6bYhfN7VbUkFdxIRYWUO8a2nIa1uJlD6qaamvmXiHM85ZuaNiap272JaJMT63v7x/Ztty3XJUpt6lhoWdbSTLlNFxdCaKtStHMFGVwreCMGI/hJXJr9LWKbXDVDM5w8qTmU6BpY4b0Ls5p51bdVYqMmSRYlMqjjZWllJNz65EnbxjPh6aNMWZQrx4ZHVbSiJCGJetU0+5VXutYEdszL+ObIU3dL6E1Jimm2OByCmyVOa0knw9odVatKk5wLKsvFVmWLi2M0GxerhBrZNfaDaZZ7FHxpSPvZCksZebbKzxXcpxNyx9as+WhL/NTKrONkdyeztfwbpquFbDGKilTImVWKo/kW5pk35SkJjKVXRxzETAQ3bPOXU4s58tvjZJrsxKKkYsQ680OWZ+fVRRpExTy9iSxJ2ZKE5W01ZhgLtPLMq5mpHCwlazta2BrWfEcFXXxo2ytW3aY1c+wTRUcFM1P6k1nKiCtTCEN2pjxsZQazaJxko1RMpQX2GkkneTJ6Zt3FlEb1G/SJpUqqm+Ny5SyWfDM7BEondIl2+bvF5Yw347SjI13Xt5yCa+kq2seXlf16FTN0t7lrWzbtqPWeFTWVuEp54/2ERJuJ1ry1FZOtlFn0hxRCuJZq+MuHahRFxPeF7Qac7KeoKgbSWhnZqSNz9YrI4+WVpRrGRSZm6LasbMUUt118x8nUqIfqG1QJaeo1uLYrfKS6rSXqWJfJJYgMtFqFq9vUcljS6tKZ8pSHnCnT+GjTN52qlaa2ySqnOYprE6k2RvuZFVN4y2lSW1x2t8PGZPb0uETFLGf9d+l7ZMPIh+xsmrkXdtpmSoPJG5hoM+RpOsodlOris/Y8SZy1+Swm+DmiJxg3NNsJDippV4gmzHOE+7pz5MaqCa1mzR2Dw4dNO8O8ButGFBlSuhhUCVSLB1Q2R8J6DJUq/LeCxbioBUdYydf1Z6hoKaR9lplK10Vj+PnXA+s4HNXViYXjhypSCISCi1mDq0dp/DRF1TeL7EeE6EZ7whSHkoQD6y1DOfl8WBYMp3yU294l1APrVVL3rFvymlSJtZsHZZv22ZgJ1EyeDqSoZoOaCiLHR0ZbhYZU9ZlqbSRTJGVjSZuaONu02InmlrTTrMnXhfdEBpJ2S0Uly35d2Sc7udYlMumE5IpbBYvL+Z1Tl6ea1sPr7TQtmpSIlqZHJV0iSzfsbDXWlE5GJYvzuccIeHnmGEHTnPwaU7kKA3xHbBNZlMNYeI2XtcRU9ZQsJOeMJmwVA0uzxMu0vCZ2NBQY9eNUq9wTiUSoqapziyqziYW9LBcWlOwqHkLkrIQKs+uSVcvLw7tzRSYpamu3QnpaiQiRaBUpSLhtCmJmczxVNcUJNAWH5Nr0CRoJKLpWCiX1ejkHLTt7Mx1G4vXIGgsMOxIkiUs5BpoCNBZ0eHsZylgqvKfHJsWNV0UEyF2oKsOstbaYlRs39lp25md4iiNICeXG42xbpFf6CJQjekpCuakFMzx06dWZtcK6xOUJTTbcNysWqrk4KePsPXp3BWVoN9qle2wJxdm4VKt8/kXuRHolWBlTB30Fc7Z5RZl81oK59/gjaWi5SXkTFQxH17OLaeO25YQkBLLL80mIi6Rhu7jqhFXlq2v5B4YaQ5PDRhgsXOfTypVWDIO6Nuik5so45LQkl+lsurrZpbK1yxjlaZf3xOoIlfSI6LXVihjZS7erSvX6qE0VJxuX6TUSdGPIVTW+xboVFH0IKQX5eOaoeqanezl3V/lZxFwIBefIq7K9GZspZccmRLRmadM5Vsx6Zmu8hAaqdXqbI8kCw81n0+gMyGWmwjarhckoZhOXExfnCdsMd+NUyCXFeYgsRvZFeFWeE3UWSqOGyFa8S8gtyBolY/lmXKQj+uzkvBpnBLZMWRbI1xypDKta5OIWfSbm52VaiJ1jSqcXRlrbxDKU+Ljk+2jHTAU9HHal0/07Ok1jF/zLrNtqtBxFWCNUDQX56Hc31Tu2VTjeaQ3lCGinHQgWeyUEua1pWYJEqI0XieUjK8m4U8vjxZYHRRpZJOU4zIXmRIm501RKS2MIumMVy7NoahVTuMfk1FfDuyNkVvf2epxLJYejuueHeynY1buY3GN558tXOPWEp+sSMrqiWBOC7HPKwogcGRYIynlZefa4MzwEk+oLtZoDE/vkujt6FEu4m7ZKpheI9+WWg7kjlAtLp6u77CaGt7MIe8a6FRiDwvKnnEFWZutIFTYc9sdnxva77eVdk1M8N6c8NZYjB2Sk9ohKLPTTdew0yFyqWHannNeHHTj1xpo5/EPDdtHZ+Cyj5f0mHJokuoOHahyayNNjmNgjZjuKy4pz2Jn2pBT9JmftuvmpcvvMd9xmuBP197sthNTdx4dGpmxrE+JkWwK2Wue29WZqWSZEMu2Uy+hVNakjuGQM9eXKRM03EaJKabY7ibN0k3OaiZOUJKZznBcbtehFlenmNI36Vt0mimNFs5eqE+JitmTGc3oVmjr5+zg4aJhZ6xJ3Kmb11pMjfRq39/TaLMPrBboz2Svn46MkCXUHV/T11/OMzdPEhUp4mvZptSVIIxUJLRL4exsht5loDDIZF2mGqqnouINcC/J2eLZ31WeMp5x7B7MXCRy8RfbmU1LsB4UrY8zqtUTXVhqj7HOjxuKLCgPGhspbIuajHDy3BceZRfO4NwiFh4hyxQxaa3a482P8avv5CEXXqDnoI+x3qGckSqy06pYKnXlEpFZi+x0bZPpyM1ka9EpynEcjmlS5aKwC7Dpa1UsLxZrKMzV1V4IWyXI7VoroOQfr0vlkg0aYWOg81zr5Bmt7SqJbe5WWONqIWEHJN8M3vAxjutcrHBjJ2GyMJcnq55k5Joa4p1VLfAkUyinHlQrYWwSJiyvyiAxHu0bk12yqaZQ7fBv4CXIXy0kY6zVT1WUj4/jchHr2POV7Q0v7ZMys4hvbxJcmcqj1HIXtFYSJc93U9uQtYrmnW9yrOaVkqFtmU5i1t4ej5bYHnCqUN92G/OS9vCNjowaapTkjhiSW7cNl1hr2CtlNI1iFiMSI5Hd2Ap1YYxzmaXnER1Y2zDh7vIYYuyRLlDVdqqlMXEolKmknPHs4VcOo2el3KlNCV5ljGvhZhCfZ6UMsB/Vq2UULgjk6a/tVt9W22ROpiYlErUXjvfc5Jvp1GRTdpZgalHdqUltYNTZoKbI6/NpIU+NGbKuaCFtLk6h4Olfpt+Rrt5s9PbrsKze4w9MLYtqrZoR31mQa6jvyx/K1jJv2pcLq1cx0lNaXkmwZy8kGdTaZCnUzPbpZt8REmrx02YQMs7tZ2PnD26vW4oSo5DditCVtPHQF4+qomZ0FlRfiJRWrCbPYiLc199dsyfjGRb1568gLBTjqhSbpvOjyhwiEs9oHuptD5IwqnIrXt0cL9djHq3qSq5z0hdP4WeQWa0GIytiZt9Mzhue3qHyL9sgc1Yqyh7qWu6br7KPru8tpA9UXpzgEqItmGQqmptah2zmG6bTqSldaFHoFiRU7Z+zMysODx3idNrTWd6x5wllmsjZniNW1Zbjxp+rLRSqUSnnaGgtSQfVENOf4WPN7h5ckWVlspqmlmHk0I4mX6Nd62E0F1/WIejRWt0S4ZCSNa/u6qlpTjIiLVmsz9Kr7pRS0FpcUnXUnyUy1KGKo7DbyCmd5VdYVjqVVqtr+C4UXctzEmXZtRdySrZkmGyZMFXraIctdh+bFdBZLFKL099wcs0Noiwo7nEQEBJyj1osb/SnzDMrCRYPz5gyKhLcTOkcpuaR1I8N8mSzDt1vq8+TViQuZRMjLxMJIWWrLfEQLXKiNawgTgmVbVAhWyVxbJdrkIyTHK5hbBVhEyHc3+7rj9EeUJiooCum09ci6kqpYqh33tdna5dwGGuubGIiVvZXN45zTZ3MG9tyUe+kR3B042xQFCBM8tpWoGHxomajzvNjT9Z2zCRVaPAiDePHcKDdoKUg3V5aXo8tC2WdaU8lGOByGptrog5MU2iPGBzXHVgqGTHsEK1wnNUI6C9UsuYsr2Mb8JgkIIwfHmHOnSTLJNmiV7TtixBNs6PxaVqYkot0W1IckuhRKmfY15KWWuJTLqJPruxgnuwt4luL5CLonUlq7qQqb1bVddPo2ODvZZxWn9GSzs6wihXrXt7LploopszcJRg0VyjepXHhLechqBqZlpliE+6zTIea8KZYmWiSVCKYdExu4ZuRkw2f46CmpJvUpYZjMZUNI47LYywrlJThJ+bVnwhr8Zacipog7B2aCvCVnNr4YxxYHSvaYg3yGtIf7xBtHR1NspJ7st4V1BPMFhuI5s0XMZNobczVj6TU15a3MnTrWaHWGTL0JpAVExCw8STvmlKg1A8db4duJx1PUmTPjhWloCZyHJlyXOamFpJyj6/OpJPYDfOh1txQtOMmyGfjJScpJqBZHA9qH1nTEDBe57ESci+gFhvLypKbsKxwD+2c1eFcCFT66+YapXVzrC4qT8q11rFx1pFwHGQLaSOv2mUN9QwwadFsGRuxcCQpb52TmG7XnVnupWXuT+NTYZfNx+ytaOyS63QVcOHMnCGKKuHHi9oIrA4TqBKPEB1Rq03tbR6RXp0lJ6gY1lpnl2VuMFioYN0sY04KteMcqY8yW28r7cofS0qQsDDQDrjROxtuVXVkYMwPozEakGhuHpSlGS2wmnP1p3BvHx7umiASSSlVsJMwYzETC8rtr2cKLzHUYOWh0OckXOoeMlzNUOERYOrdyo6yqJvS8/dW4I2zI0rQXm8ib1iW3Q7hqoWUKaQoYqZr5Z3oG3XYmCLXkBm09TCPzG8nytfb2jXaYCHMnkl1oDIeiSMvVpKgaEx0HokUnBkJiWdXBOiXY1IQMu3YTsjgme4r5a/VHrBlZe9W8WWtaZEM5FSjY2Ln3a+p5B+j9BQv2yRfkRpwz3Km5Snal2sRZueijpGpDdifVG2nk9h21x6vJwZR3YieXVUWY+TusW+ZD9EPtCkYZNKhHyfZKdqmGqKoYgwz5BqSr5ai4SZKsluaVVce7hcrppPt3fFQs2WQkeYxKc7jl7JQdarUjkyYCzFnmuYKkmkTNjPP0jPmy5kf6pUuotudUKJUIkutYiuRpiSVHM9kUtcmlmXtLNdVHLUYWlpa8hJX49AyHvAW71dUttwTGibqjNQvK7KQkGYa11HeymKcZZ8oTBqtxq7tphDkNk3sFVHcqhPLcyWvZEXq2tphn7FusGpgYUsfLmsHbQzXUmUOCqIrnRgtWNNjMVFJWfVqUivVKKBxKWRbVIro7NXMWC8gGB+X4bWkyqzqGpfgGRYrTqutzxRu54tcEKkcTZBdW94xVdIpl9fXD50kSmmmpxWhFE2iE1IzNG1lEhytLrLLT1gtL6kL3kmcHepqyyQUKKqTjtJqy9JM5BesbSwUqiKY2RaZWlKxqp1fC0wZ7HXQGk5pG1Bgp+FxEZ+rL9mcMocvheEmjCYtkWnnHhwZtG0xXNRlI97YS+EvWNxbCFTn7NZpYCnt8JuYcJsq19V0H+tzGaHJbmFV3POaU1cVpxfmHyKtWzBaaWx0GGgXiZnTG1kJ3NLL3lNabqWa2tlxpZdqBhqgieLsqLOvIWyWjBufzxpfWNWmbppOUlLt9GeZ5GIg3yyRGZlgXJygqVPnLOsMJutvYWzT4GMm2s5gl5TmX3KqzvKnRu7p3mSe754x7ZsklotRWStZr2XNCqqqUvAU35Iy5B/kjvQjF68gqREdTG0fXjQxZhsS3zcT2lY3ouJWq+ddLYxzsxTXYqJebbCRJPKqCJKVT3Q0lpGWqY80sJrLYE0OW5tNIVmsqSXV8B5WMQkiKqVhrZGwKuERWBVeDuAdmh6dISZXpHBNM2OK1ElgLh6J9NzR0amz4FwUEZmt22psWOItLyzOr+nqG62WUO/KnC+D2XDwFy4rTuPxYWeg0KIonw/pazNYzWEqIyCbrw0iFlUoiYt2Zi8UGalxUxvjFNBckGfZGnKu0OCemd4kUaDpcXLuZFYYmbJupRGhE44uLLQpY7JMKFmh5dtx15aYK9ZNFhTyERDScvFIpatI5ecpEBIt0Mrvb2/PoBx0Zpcor47wna4oHcVFx6DeZs227DHgkaRnIpTemCOubTGco7MhUyLSF2ZkJuiXKGVurzESkxgPGKRo6a8fTvakEB0sq9Yp794PWylPjerO4s7vDXD25xIT098M1dqrzigYGCWT6NjncWRuzO7yi/Rtk2wm6RmNyTXRZpdRKeDzT5UoqagTbx6z1SUppU3MRjFgZcy1EVUh41BxYe7V2HOakjKp8hTgdqHvpJRzdIrOVluwZFF2k9TX7Smjiq2l6qfT2TRTkZTeIppmzRtpco/fyaBsY66eyt6mo9zyIaEvquHoHTEVUJZqTyRw5I3qbM5eolumFE7Nst4g4iFPcuHS2XNWtQqm0WrPz9OWKN4jWJUXMZhgzvSwtcxcajey19waWy4aqfHXoFSv7VWVWbFjZ3AuYG3iUfMY27MgzmtccmvjYNLoRm4opJLZ8xxsEFhO5RmklGJhGh0eot2nSSstYZA0lu2u1oxTMIyP2XadDVzUHWeiYF7SbV6IHNmbkDOd7uhiMZMl2CpVYMyS6ZLmJY7qyZSnpKqlF91h0SAx1PIR9F/KMFCvNF2ynyDVIiZgLl2yJVZwERGzE6qVV6WQLhUp156m6FcXGumi6WafGtlMnzGpMxZbciTunGSlqSiZFS3pWNgg46AilBjUWGBSaxhuZrMxrJwr0dgwkZYqJjLqzdcSznGii59nntzs7A6ima3cc4yhk9DzlJrenuge4iwKpG8ba5gN7B+eXB7mp1MWpWsH0J8LK5qX5gznGY/T+GYPEg7boKXkseTqy15QJChZ4luYE2lt7SVOL90Py9705m4cKxbz8LGnmbTSH45V0WoLotejidMs1hmRK68W1ZRZC1Szm1sLJGoj865sa5Xqme/f3F9MH/CUVTWJapndTCwQTtYNJlZs+U1g5t+VKRKnV06TIAxu2SpRoiZlViV1DpT2ZQ7dpS0z5mxR1M8v6CMR55PsEFHYzfCt2aTUThGLbyEsB+RWGLZoaUtpIy1kEWkYbylLSYdsodYYKmIXk+OWcjOZ1hKWp7ZdHlJSb13o66LS8xLL5tEMHlbj2iwr7MzOWJMZpfnSKKtbrF9ryY4LKVmRrVSupmoKXNtN1lUHZoiSqlIZ8lMR8c9YNKLpVp4lnnSnGadt1BMhMRWJ56/pol3X4ifPNGZgZt7aNifWDMcQbREYXyOfDBEfT2EicNQab1UrKhCmjQ9Zsi9v7aVKSjOkCKpgnrLlTugQUmpLIDIr3JhLnduO0I+uGxdYTZbvcKPUkGujGnVbHM2kcwkRISDk73TNWNmy1qcmKt+l76eXjEvX61iSYd0sUl2VMiBanZBbVSLmMhBVobGwHJdQVMeTXmytCWLrZBtOrlsz9zJxS96XLuyvKwmprLJkGRjsGc7Taap3GreWz1eTsJwVSaGWFbFOW2Cc8uhZzdYIGlnoGRrVjIsglrEOlRDYGySlaiNaaUsaX3avq+VrYCRkHWAo5lRuMeimGSMs39tSdKYXy+1bmzbbjJsZdStzaNcynGoZ9dpmVyeZV6ywMZay4Y00I5NXCy2ZnOAcsIzXNPLxnI+Q3M/ndBHl9N6WV6kspuck0Xql0RtjryK0sk+Rp7WznqribrQaUWwRy9HoESgskhiKGyetqnMO85RjEvVNsw0R8JJs4aFKGi5DX+luWVxmlWEfrJQZZucflo3S9AqPrk+xZFDb8xhbbJ9YoC6uWTLj5+J0NpQtEac0jQklJhKYT58THhbX2ItiFpcrzRZrdFFj3JnW0nXRIthtqtrjpiy0GiPacRcWmK2xLFSrYdzMA9OaG+tUHixdmKpX36vVnVxp5uMRKo6gHWwtoKMQo9/O1jDuqp/MDh9tzS3XaN8Z7ebssZcOo3INXicQL5ty68mQaOm1cIfxS96X9S0PZ56co+2Klhpq0a/SLmElsRVpkhCyDWYWNzai1A1QF1llTNBynOYWIm8rpGRNS2DMG5JlMXPtlqkzpmpNFmVRitEKT11fSSfql0hoGaOxJx5QJvesL00sz9uT7V5y8ppvsl8KbaoQlHMSVFKb31FoHlbvsKNfESvHryUiHB6SWeJlnPJxnQ3RDhzfdmxVde4LJ+Kl0J2U1SAph1ZqbSZr6fFulKju6HLN32bPnR+YaZRvXyQmY/RYH5tYo25uZgueEK1Kl9WjjTBjEy8pYGBq6CSNU06eT/fb2wr1jJgWcZlwnKWgcKMa6Y70p49dUrayUuj0U0qsp/WelNNmEFTs6dRZmA9uj1LV3xRv1HXj391TlUxpFzSnJspXm1RwYpUxIgkTXeJa5Vmgom4PkaYUIfhYGLMg4plqnR1Qz083L6TjmYtkrk+QJ+NSI/BWax5jKijPbxNikFEjIi2VYSDqp2k1HuanklwoX5GZlpwjjdfVHxOiFGmnpI8ZXGAZj2XvX1/YLCfz9wvo4CJ0IPWQNxGVM7Do1VKeXVQhnV9hlx2aHy6m08ustSVnJVpOqp3yYe8sYu0cXuIr8IthcaDmouYLlCBPm6bXXKAkqXPrD461VOMaZ8reJaChpNNu54ThZsoWn+BlrOQKYN2Jbq0k1Zkt3awOY5i2Hi5WLVZr3G34IYvyaRgc2Tf1mmbJESvrVmO0s+MjrM4dC7OtYqrcaW0WV/UOoFhaZHIyY7Bn2dKpqJCPFvKdGFZfTplQryNqUO5wa8+MqmfRo5hsbyXljdF0p+eRacew1yidzWUhCiShyySs5+uiJ48VXhOnGSJbURObnoqerIioMu2L0xyNdOzOth9hFmThKdKXWKQiCWhe77DS6FHf5I6n504w6qOrzXGhIatEjcxqtaU5Ip40UgcunSJUG2Be5WDaBgaYbeqXIeCNpHJZMVE2m48NquqM0iH02JcMrdbuDI4mVqBUDrcU5V8Qruca4fOVp68goUu0UOGwbIyJcNcw3Y7PMgqQ28szcfMo4iH10Mvt12Oymqbg3DQTFYyVMCRGoPPyTN7SE6919g8UGk+iN6JyqFrcT58ZM2SLEe+d4EvMG0wxZiNVXHGNYrJcToiY1qiZ3+klIm/UjGOvXd6UTgtrVZUskCKwsy4RNeZuVKNhbVLw2WEU72hSTVq2FkwpMRuuogby5yXujGO1zBTfpdKbs5+izNxxlFWfqRJi3mgroKGiizNOJqJQ6SDTFWwMq9TimXUSmTIMsXMWKVLIr9kmkGgRYB1tE6b26CrmEpRP0SRXlWheTBySbSldrNtszhhc6KpuWh2JrU3Pb/Ca60oSl99iUQrhjKeazqWvkFKeypSTZqewCjRWHWetMOiWXlYSaGzGzSfNo2XyNBKdlnAjlbNLtfIZWi6QGh8akSEv5qPlHNka0tUai9ro64rl6x1U7R5Ks7OtcF7XKJ4t5hFxrYpl1RqfqM+iYdYZ2RUX1yBUn2Vr6Rps1U7Y5polsJhKYSnf4OXPms03HC8g5Ccd2DFxiqMy5OvS36XaFd3iU/NvE/MNnvSuTXc1oF4v42HcmSzQFqprJOgwK2ohFI83kFUt5EUhWvTjXq2inFycj/BnYo5P3V1unU4lTE1dV5C1idrR34zUJVXZkeycLE1Tn9XaYWqSoN3lV1yS4bN4F5XVTilWJB9UrODnz85W7Vco8NvPD46sjSlZi+Q1SxnjsKGOc6Wd5owbj5bx6apv441iHxvh3RYYYdQb28/n2dtwm2aiWg5TDqufcxyT7rNyYKAuVBWg4+K23h8WtotcdN1h8uPyLQpYzS4uG6wSWSqZ7mRj0BTli1x0jqCmqLtWUqPS6mms5bBNS91a6ddRDMsrI+9S5lyinTYiHcyw0p6Ola0OWXPkGFbpYmQOo12TZuRkB+lG4RtHmtkrXaTa1rKx7N1O6xyiiO8xEJ/n5OyN3WeK3euo1VGo5R6tU13pHg+zsCeiJeCd0fDusRvWrbJfbSmdEd70jFoxH9dipVs0bVjrYlylWVJU564jWBVUq2MdFxEcDw0RW9LiaZWz24hy5ZZb0BSPDtqxYqJSXZk4NY1ZKI1pJZUiJlnYRxlKLlipMO9kH1hQjtQQGFtgKLGL21v3a5ookiWqakxokq1HjyDIaZCUq21M8u/jzKSgcRMTGtIkkVvMpFyvWbKZYGgPHvQRYLmUUw+kYuDlFtoTDCSjUY4iVFhzYdsq5hCdEREi87dOWKi3X+HIiqIH4NSuFrJTL2uaJRafqKuvk5XobuZRb20SG5jcSyEpnKFYWhudsGFR31xcpk/ijNWuNaAe5xkik6urrRrvYqyX7+mj2g+bN09Xb2LP2qqSL1FZnqoSjU5lp6Utz9SSKLStqmJvJe+ioRWzNGf0ZdNdFNb0CyoRWyMhD2ZgT4lerQoQ2kqRb++zjBSjWJlTLGfWcV9oouGaae/IbKAtFfXU5BTuF+7O1ysYy2xPK3Gd81Vx1M8Tm9uc75oukeX3NU9oEDbMUOmg016cVl+z3dRwVRIO0WDeDWte761ZVi1ws1euDN0a3hlMbGeUkq5x5F6cWKgQ026YGFgwEGRP91ZmEGxQriJhGt5vYhBsi2Dt1BKa1DIR4Wgm2u3P3TNcFwgw2NCd7rFgCp0rmdNbLNGs4eVQ0mZgXVumIR/azhiprhUvVl+fJ/HdnCU08q5qnDIPFOwNzo9fLCJyG+/LYHFfaBXRE431YDbT5lCdnxzQmMxYDSWmbN81rDKQ106oE+TP1JBOVuimzDHq6hccndHobQ+tF5Ds8WmcrmouJV2oy3De6+WPrRtMGVHtYTfRFI1YYu3WLrKM4pHt5ezYT7Mm7y6IpSefKfBLmxtZ6V1x8bAHHNQfjXf64hVSJY9p39XYKO0K4mFTU06x4rQOzjMTL9MdouOOjWeWTRLrjC2p0qUIKCNJpuumj4dXIQ8pndKI06QhzKRq5uBcnM1eUi+cmTRVqqCybaPp3vTjdWNbTqn3JtImqVsuWbBUY2mt7G7arRgm1qPQ26qPiNTqFple2s7cknfmkx/vaFtlXIxJ3iXwrDYUKWgTaR3z2aHPWZEepK2lFeLgDbBL5Oz2jqAjbuNU8VxZpCqan/Aj+VqTM81iCw5OLqvay6bO0R5fZtwaklJyHiid7zQljOcgrU7ndRycImblExOS8jbZZ9iMVu7rNyoSM1DdDGFYSxZMDd95rtAVLy7hi54HkidxbzIY82/dWp8Y8ixMEFvfT96vqk/mbO7T34sts+gtqJqmHpacNFEPaNUocZ3jDWrvoyvkaxjPcSXW+VIRF5QXqCbMG7AUI+flpUuU42tUslZeNA5hD6xSTzMtph+eo8pVVg5hFaUV6eiOz5CfW6vIFfEaF25rX07lcKboIjXcj5cpKpOrJu5ioaqQJnHWojQREqNcdmznGYovpxSebq6nLexLaqygNvFM0GHioibYUhcZsmnhJmpzFpzSD1olqLQPrPJTcJH18pXNGK2X12zXEtJP71Dbr6LT669TK59irGQqmBwiphrKraVm7Zwfm+1tV3VqB9Uv3c6umOISMKiU5ZhQUlshLxlxUdCij/IhF6dfopajjqNOUZ4w20whHmYypGfwYrEa6DHMk+qLI8pv5VvxImjWdwrenNMunFbj8FyQHFsymdQY61OVUye0F6YoCyEh61KsYRkL66Dgq5Xco9/WB28ycaIwFOak6ZruHuDWCZWxpB4YpWhTqcpxzVZhcI/PjeXZ1xkUEDIUjCokViepnokv22bQ11Cx8aIa8FjWM4yzbOhqZK4pL1mbFdG19a5gH+BpFbf3K1+cYZaylhNYLNKTaufnB1UnCihW+LXP0Jxm0mnPpE/OkdCLNSOZ2oqwX9wgzPdUnOeY9WRbqWunWNNOJ9xoTJtuUNRLSdGMbtJR7ggxGTQfFZoNcpmUz1+b7i8j5rIgI89viiQPZiYOanGQUjZvMwrkbbBly7EfIZxfcs8UGQ5TatWWbN9QWemZICYhXjPidKZR3Flr7lDQXukp5mgiT6MaWKYpcNvc4l1Rl2Rb9SDY09sozhqgJqfrjizMaysuFaXQD/MsnM7xjkyba1xjZcwlqdXrq+2xlXQi02AnrCPe9NMY0ZKNUzU3lGVTjxum58ptzOzi6Q0kVu2KEYwnj9Hto2IXjnAjzGXomYzbny2zYnGTYRBXYPiWUy4ksSnn7+MTzN0azXAxlGkH25utDigtKYym5xrkm5WiWKhv5BJzdQ/aFdsmotpqZ6tocU4y69FcZV5m2KliVS5r2TC3XBcxnpGgTWiMy1QxrMgODlTNGbBgFOYMoKCgIO9jJCETGSPc4wxkbQwq6F62UTfSU9KqzkvmYSWnl3VhS5fp89I0r9/dZwrg0wlpC2lxoVIK9HNypSwXnSaozPQUGmKfLTZUnqMxaqxyLWwUqBAQ69oupxOMzyQRYmqnWS5e29FXz/J3dephEZ6vElRSEaRiV4itCdDlIpAY05UUjDIsKMwqIKxjEUx3OpMcE5Tq3OxmzZhzIxDSn9EOeRGjI8pnkmpSFrMTZPXtn+iYyBYkd+GlmiQJcOKoGmgjcR2h9Q31tK0aoytyD2VyGBLfzTVV2+ZmTCLr6ytRFuaVI2GiHSMRU+AWriiVzE4wm3MeUmEtDNtl6Y6gUVAZkcuwmhOQqjEK2snt6WumcTMWUiKKstrYbBoMUrL2URqunpFfp5+uzVZwXGSMl87eEtUh0CzNjhy1clpuyNKcyrEtCZPYkZ3pyPbNmowlXytmHUftJa9caZGn19Cs01XMYqNJl98wDy9T2F5VIhooUJ4epOavpLTZH0tkWOjR7SRrjezvZdxxFCiejqvVZc401pH3jV0hzWUNlhe38inuJthRsycV3N9LKbGT58lvUw1QceeecEUqTzGMyPcR6k9PNlDd66qJoG2jHPTuF7KtcNkr0N1nJ6IwkR1pXx0pp8kitFyYUOpvcVUTaOmrJa3YD+cjqlwXsLWUn/KTYmIYHG21VNsxrNjhhwhx2nLyMYyNrTarV1Ps+uhrjsqLLZZo6dQkCHBckpXhdaXXT+bQrN8ei5YtD4oY6XBYiTDrV6Ef8K1aMd8v2gxe3uOoKnEVI46TUaKzDKwNaE9eMaKr2V6UIOCrjFT3EhIWoiNPZF0XWp1ymobJJk8dFeDbm2vpH1xeFYzMFxxktmmMra2x3ZBrX+fpDdFM3h+ZnXhX1pNil1mpdC7a85/xqqRaSc7hyGjzb5EX2t0pDuSdq1BtF6PoY7Cm4BYsKOTsGFYf72eg8FZxnEw1LRMv7pHy5k2mpQud7tqP2vKjnNGrIOQtdWCYFpDq2UrrGNnPcNiS5WS2cFyd1hKwNGWlbtQzphPI648fCeBcp5EhH58W0RN0HE9msJVe0vVgGOWzYJ8sN951MvWSE6qzD49vJFTJ5uJOXy1iHujlWJ6x1q4U2zUOMpowqJXblGHwWt8OGaA0LeenJmCh5M7wGAugYV1t4XANztfPDtFdZqdcNNjwJB3msRJeGJmNl6qr0hIfG3c2ld9MsG5NkRrPpxuQ5tPWpW5QaRaODpUi2MxsSBnO8XLhco5R9J4S058m7qgK4lSYHrFtTUxWWKH0DZTOVzFWkpkNbA7KU14n9FwzkNAVsp5fGuIYcK0m2lXT6thTIF6HsCQhhy6dnVSm3Cy6tNOlZBxSCJlQmo0N6iuxLhegHTahNUhQXxDSlNli8aAk0mxOZlXf7awwz2fSNNFO8dkPI/EaXBwIESZTKdwYSRjQI25ykgz0WBGn1YuQUqLRodtLoK4vzhMbeWCK1KBwqcwpmVDh7lOhUvEwo9FgZ6AuGlazp+40MqKP4rJsY64hXyWZdeUuGRyMUaOm8FKScA+XDrPVYi5N6uPOb3HMsuAenVghMSabKpjoZnJLHl4XsyYOq9hn5BgXHSGaV6CuD2wqYlTRHpQ3FdYdWxFLYZnz9SFTS5RwH1QpGE7Q1mgeDtG3mLOLiWmO2ltXVWdaJkvU2WWJp3jPZc6vtY7OG6sjnykwrt+kYSycmKDlsWKrVePsWN5qZGlRLolTlTGkq+Ls4aklnZL1F/HV30rP0m8s3StbNZAS7wpQ7hny8aHx1NOnm2evSzObKOWbmtvuUxijTS9j6OgrhN4qmt91X2AOS04s4TKI5odhWCWuY8kiLuLLdRNe7+HVI6HtS5gZsTBTl+RwXpqtC+q1rSQp6epVUnhWokydkWQ3cumojFOLlrS2TtqM2rBvrOeqEchdqOkrJhobm9ErpLDmHu6sHiTVWuPx05Qr1fFbk+Bb4SdMck0f8y5lKxxab1YcmffxW4sndFFcVmYti87R6vDpmu+kK8RxLSWlaZuyq16ZamfQHBQsJCfYUeTXtGhrsZjdXCIYEEpyXAraLxMSa1enn3TaYaMe1LEZx81h05mezw7qDy8Vai7g4K+fquOQzWzhFx/jLq7SKZzRqnQt9upb6Y8PFRmpa5Km91MprBQz25rxFt/iq4urqi0TkzXL915spN8LXBnWUlTWFlJMcS7xqYwwSdh2rVhUs6LkCpwlMGlXGlXp4c6iJiJwzZxwMFOyHTlNcqPnk6PIXiRZTubon21uEdNN508L6PRQ3+tTnTXmExNdZ0YNLlfbVBaMW2Zb3hRkKS5SJBsep3dV0ypqWbS0Fcys6WHe0+krrdKw9xiZnmPtL+5JI+xWZde0IChUsLFhr84N0lWwDyWksW0HUdAQ46TbTLKgqLOxD6Bu6RiWm5gWUlJzTaHt22ZXTZYZI1dnHFah64ohnmDeYxAylnYTmtT012ZJMxLur8rY2ulsF6mNDF70is4m19Am82+f1KLUNR8ub25YmiywYmRbCRyldWqwMKkmIPSVdOZz3s9RHBcel2sZlVjY3/WRz1ZZ7w3VXuXKLoksLeIupDXeX6vosU/0NKuh21scC9qjlfJVjZSlJKDocRwVtJDPEutcXNWh5dHg3bmlVLQv5BVfDaHYYplh4poHps7N29iiEaFOqg9h6fFsMq4lHpRmWyKa2ujT25IYKMusox3qJQzMkabS527LmRfzFaenUGuLsJqnb8sPqPYyJ25hJeAcq9oQGqyTMl3VWe/Q25K2HW8abNSwEI8k00506Ow0IxMdsN0cKZWqLFSnm5KgMFAZzhfLr/bfDmVhDFnp7lBUMWueX2qUXptO2FFn7+Nw7RIelMuMGzNiD67rGpo0VN61nCTOZGqYUFGtlZOf8pKd2a2Z3gtt1+gp4aafJJi1EHKNa9pOp4wf4JrcXaXo0CRc4t0S5NWM8kvI7HOyDI5g1Se4Z+QRqShoYiKT6zASkiY18OxX1h3Uj6yREozMtvav6tGRZqJ3mY6M6dDw5s44VB5rLeqGrOGRpwtSkGAwD5rH0W5SnSHTb9XoJB8rV89x3dbL59xQT21j2hVXD52usKcQmmFXYnMJ4SRXkJduaVYwMM9L4t9gmyTerK3dstpJZTCyU2LZ3ZSToDUOWhYzER5Z6esR1y9Sj7OUJaDrSErPkS1kGNWs5s3gVwuPGC5fFRxbbyDrWVAcV59S3iTWWlKNJ9MmXtrVVDFOLoiuao9UVG8xXlTfqBqPXGgiIdzLpFNXJ+wrSZbWG6agMWRl1+Q1ayonCYdFVlwLE88fZ+/yhnFM2pdQFnoYo5uTlY+Pb2RLq2krzrTUne8tAmvvV7AOneRtzBSJDOJJGZELXlnRa5VlrtpxKVyY5tWoG1BcrqauoR1ptRqpcOvxrB9VjpTsZhWoT95Ql1BoobEwVNlXVxgiUN2b0CBucKHhzsw2IpNlMN2mlLTrExCrsc/YpO6oKuTPDg9QpY7hzl4kYxZ20yKLpqOdL0tbLN9XHqxf1iCo6PBkshBoIdebcysKKpgOHJ3qzNCLcovmYuWRK9NaZshnJ+gqCul3pOxv0zRqi80tnE5SoOFJrORVCl4i3VlhEysOD2K0Et3n4WcgaTQjDl4xaKY1HyOvtiGyD1m4WUwhXCLpXg6KT+i0jXJVIigWWisblSJmnWqZJErVII7djS9bVxis5qBxa6JaGacyUhOPq5EMDhgyapSlNoqqLZ3PJdsx19lNqkzHkS9c5snn7eOviivxopUQnW7jp5dmctdt5d4036+ckYyX9FwJyysoFjJzkwkkaTLLclmH2RcNVdeqEW+1n7LlZJSQmpCq3Y6gonORKOrpjZnzIRLlca4XLV6J2ClXnt2TSWG1YSCvoV0T7wyyrAoWZ1SyaigY3UqeGazssthv4Q6RHCDR7bEODCbT5hVVMqGx2PTMTCxgl5vasA/GXZHdVqrbHc7v8jMXnvHnrkps9fZT85LNV47nLuLfc2FscJOfYDAU27GSMJxUbRoMCiItnSUqF++SLe4KHw3RHm7cECcxJ8yhVo6n5aNoikmxjZQfVpKM1VZa0QrKo5NiFukRIhOUijLI3eNqqNd2F9nsYIxyksyaDWtP9KDrJkqoKnFNKXNv5OdWj2Gv5FkqmKZpTdGfb+uvTHMhUTGzsecwGFAlDK/XU3Xm8qZsnalS3rcKjeshTpLJ7O8X01bJp/TOmVZWD10Ob2CSZaixL5n1jjejVZLx2OsZaJogWWDTUhjhS27tZSXbWyeXjltcWa8W5GROXo3pz3MeT67TIpMgdxEtkprPH4sxSSpW1tCtIS1Q4B6fjeBUdAvi7KdlbLUc2GyPk0pwnU9oLZgO8doU12PydldN9FSYzgqtIlsiqcxll6oSVRThjuKt3m0e7N0tjHCwClCubyFj0lgZMF1lpp8v4CKcUaVp965aix1d7t/ez18kXFHaoNXZDeS0JqCrXXDuaq0xklex5FlQVRmhbUdyLqUUnkgltI8oF6CM3eFuWPIqUVSoqqRyENQ1DaYuaaUcos1o39TWsa8ZK5cv1SeLneZUoCCZkE3tjfOHDqqhJBHIG6ps8aobr5BP0LBn8rEZtBivc+BdE5p0r2yqU99djTEk2NOmcJkm5SXeEangnInrlJefWS3Rr+EVJTOnGrDaYijYTalfI5xpz1Pli3LZzZ0yKRSg7CMdZy2cnmzvXVjq4stlULInJC8bV6UkC6UYpV3d2lnjXd8Zy2kt8iuT8etwp+8xbxEtrrKe2dItFO8NJbJLpE1pk6HMmyLV2BeY3eW0mmey2GNVZe2r1BEKTtbnYyMyrO1bTmtZ8TVXEQ1gS6FP2ggZKRcN4I0hT2J1mdoaJOxyUxNcdIzpbnOqctfYGSos3RRxStWz8WrWJ6MjbZ4Woy7ll+mvr44hWHBU02ekE+YhUEmksx0vC1YWM5nvW5xTaDRfdDGO03BL2xIs5XPfI+Ro8i/vY5Ia9lIQKNVcIevcKZKRLM9qLpsy06efyphSYVqdCUon712lahB3cSNdnJmxj6XllOOiJhhuEVkac3QdVKTVzlyf3plh0O4mjHHTKmAwLqwly7LYIF+m8fIpG1nvTtB5DpLska0c8M6WltFV3RapKmqiNo8gYU5LU5HqGBoxjs+eUKhopRckoicx7jHVThbgH9ybqJVTMysppBBkS7DL93VTqUzS1e+c6CvmqN8WlxxhJY6uWOse1mRj1eXpY46msVgTMqnPHSn0KuuPFWeVXOcxXJImpBmUKu9HoKrpoqTIb6CP4POLFFAg32QeG1ylpSRX8RbPUtl3aazZWdRO6U3xI2ONLpIOmHbx5KASKqCrjzSgXSYQT9hcKeNta62RpekdTmQpI6Zjc26iSieateQPEcyDiappD6Os9Zfg7pVsqeo1pBbsqGcwsnCnow4N7CAp0k+u4yNMlGsSZ6eHF9MXECRO7eqTbFNKcBncLU8NaXVYXZbmqeJ3opjQC62gXaFj32CiLtjkjehKVFHXUTlSZZrPNuUU0mQsjoYrWmUZcjbcWA3fLuubEEzv486UWFCP8I1PLjAmHEYfLByM4qJkJ9amFVJncaalF1rvC1ZPGeVhMhWr8mPN5dFvKp5TW1cvy9Gda1RlUbGrKCFz6KVY8G/nDunN2hoS5c/UYg4qU5AU7afl3iPl3SHYSe11IQydzrRN55Cy7e9a41Hfz2zXL2xsGypjbVqbziDv3JM2Hq/vI6xvTosqEyzxys7tMeOJ8CwmKCzf3N3Qsa5jCtIQZhySDBwnqIfuU6YR56+R5yrp3hIao5R7nVQQlm0KHiuUa6GrpWklohxzqq1P3dv1UVsYJwzOSp3r7fDay1ZxF/MY1Unjo/Hhpx4Za5Pk2gsxVB6XqacdU1UYn2POZbCvkU6m5ZeskXBqz2uOH1Ov0Nm213carDDN59ym6VCel6+Z3A6wnInkolyNrCNQ2hgoEWzWp2wkcV+dFO4cFMovJKgOjt2s1qDmYBBGXixdrm8bLGWhKaWYDNQdaI2fWd9ZotXW4yfz2mSgrSaHSSSxm+YmJ1acUdJzmKoY0Mz2L1/v9JFfMN7c1NHXtF1Lc/OcohaWVy2pLGhpDSPs3FhnZdyzl4ldMV2h0x2s2k9wXvnYavKbizC10a5oXSduNLcerKaSX5yQNVwrXDLLm+6LpFXZcM4uYKbZ4Euk3VDjmu2aUBuurFyN87NpBSJt3qSgYfUgZRPhSQwxz+XqGlAtKhfo8ZKeGttoiezeMk8zXNXPSyyZUuqMG2eYpijxXRBbZcur08iSaFdiHw7tXi8M5qvRHu7dlOHc3w3foWinMwmOtJHnd/gusSIgzy9Zaiwbulcl5wri52rT4Bxy49InT+mnjKNd8B7kqB4rHB/qEpbkVRiN50zYUGL3sZsqIWC2ES9tFmVnJ6WwKybek2fmVfReyCqnUQjk1RLqoM4Pp3PsacuRFRnrJq6WHmFiayPMJKqiC/Pi9SMUl+s3puqfVpfXqh0T6CjVY5AQTmIo6J6jiPNNiuCzSNHmn6za7CmNodhfmPRzo2nMy2yo4l2jUXLd6hly5VxxyRRzI16o0Zj4DU7kp07dnC5h7ZXMzeYx9JGpFKGplNUQJzIQYDMWZE6dprg5j+ymbDIazg4rLqjRS83dpDBTXogg4ehK6mxu3ZJSkXTurCUwHKkm7HWZnc5i7x2QsgsojlKRGNyMX58ZoykR32zVbmRsMEohLNxPqW/XGs4VqYylKZaQmNlZjdXyKhsrcVrNqvIycorskMtZ3hBbJS0o2VDLoWqik2NwqqfUyF1fpOTq368VLkwRnW8hYadZI83NdZBdHaFxmxWsrRlmW5ucDBZaWExrMPUnGiDvLZMpWUqrMR4i6LQgpJhQz9cecnGnMtQw3jFe49hVoObrs8+P7ZZpruwWji1g0aNMoaZSXEqtbw8bLqyWWBexlFfer0ovoOIK7Mqvcw4XKyxZMFuo3VvzsJNQbiQbpbaa0FqoKNIPKSsLT6BNL8yY3SNoGZrW2KUimAwVoM1qaSYRGoncqk5b8Z+RblKSz25K2aNxmGkZLWDjViMd57dTod3wEphKE9hT1W0Pks8WUhdhWNSb71JpLGzpFiEkF07R65RlV7Ff5OGXDTcOkfBkbe2SswhPatiSZ80wnXEo9JVMGaSS7Bm5Td4VzdEucV6n0NQtLiDi3V5f8Rgfaaelx6GkEDDlSRbQqrBQq6QGq5yPL8ue4vPeWw8V56jOK6hnCzNeklPYcJ3XMs5kk08czDEZbzLUoE7nLfDnWY1w6ROOqFzQ91ehEF5lctyd7c4q56wUm2cQShdyIbKbme7PHLSO3Ozxk9pfr3QWEE6mmdgnVN1P0GyWMhTWq1yfoKxeIlEe16oTK0zqWajiH3bSFuUSY9vQB5mkZllX4CRglceSIOow0hQg5kpct6IYeOTVdExrVNPW9E3X81yRlOJZTy6S19ORHNPgFtmfatkcWKstH9hZUCGPq1llWU8jbXdQnKInZBmuL5QXT0vpUrTfVfIo6NmXdLDN8BYgYMpr0xIQ4mHm1KgyFVuTk3QdF7SSY/wP01bW6WMeiYiKKW2mdpwXICTj6vAgiLA0CFDkpyUza9dTUI7O3m8YX6qU3fRwjIptb9awK6XlWNCwGrNV69lqiyYYiM9lrLCv8XSQDg8nz6WJLVwH5OEuWFHdJxOTE1KL3KRN3ZD4dJk2C+hPkh+rp+cqmWUS8RdxZW7vz9Gj0/LNnBKYLfAL7OhLCyXl0a3YLvcl6SraU1nNqFUqXBTVjFDcEE3eC1Oi7eDmUxUzk1p4KjCxmw0uHKAez9fiT1NlzhbsMKoHYW7l2hTh2RuW1Hch9BMg7Css1N8TGvRY0uNxoiiTpmaXbybNr8UksaTyFarPFrBx7xgf0Shb6lnYzuJhjFlrkTAVIKGkEkyYDPJfy+zSqh3mS98co7DupBqWYvDJ3a6Vp8zhW+eoGs9O198QH24e3SiYbRCp1edU0R2rDaJnlpFyTbCymtKntxPI3QWpa+yHaQvwnaO3pJ3112jSSXKJIRIdjy3N7wuwaikgL2qsqaMtH8zZ8SVR47U0MRvH4xHcVt4gieYxbGMpZeAVnLGXUt+Voatiod4NFSxrlJmQTsviKSLzXtEx4fSJ2KpuEuXSzUhuH6pbEOoorR/rsqENKMxQnBst3CzX0A0ZrN3abFjeyBeviZcpkfDR2eOp5uzY7hKJSnGgMtqZ0KQSqFuMX7EQ86WY65rSm5uWEyXn4mBQ8WOaDpFRcg9XkikTnJVk42xyW9/lmTBiHqR692xUkTMP3mCnLRey81qM8RNN154M1K+qCSFfY2ysBKrZHDTwUJ1bFw3fLykjN1/aGGk0zyJy6yLYc87wb+/anFccDZqT5XXvp18tx6oyayDyG56QHNF0HedsZhLs1opjC8x2Cx9JDqbg5BiZM4/RjzJZEmWNcWMc0xpZtCpp7nJizVvy8GxmDCWOdSERXt/SjapgEd4UIyciaPGvM48fKNkoKEvZEJWQlqJcVrFklcwUU5WW5pZgHpLTYd0V6ywpKEtKGyuelVwdbswunJkYolFi0uxTqzDPK/EoE8ys7GJaa/O0o1Lm2eKSJmVltZezHFOJ9ZIv6RluLCDMJB6OFw51jtxjkIycb+lM7Nnvr55ulx4X7eWhUbIO0SBk5xhgrVQuE6qsJ4/m0Nmv0Q9Zr+csXhVUCvZRdSNd2VZzbo4OXFqxV9BxkiVSMFydFR+b79oeo2Vc6eLW1JeoEhLn0GiSpArmUJxvCDIvYQ7glKlotoixqJORFnfNZIwqi+kZDyQimg9KdG3ZbtfQ4/Vh2JjSILEj66mr7c5hEN8asVVxCW6j79llmxWgJ16rnCnpXCab4mZiZTAbXk4H7mmZntaJ2lIU6VzdFp8prNYdKJBzFR2VpWYbCzMOZGXTrelUU1xsbGbcI1diMmAgryKsYJdMVG8sEE2rhNDZ7VMUI3pUs27tnzCwzoqtoejcJVRg36Krm5hadBLOV2FHLaMwcoyiGWqWCg+SJG8lY+7x2CFMJs/kjsuoamifUfIarA2ynPVj4BjfYcqIbxaUnyMhWpIu1CsX0BTbEAxoE/G0MNRfcWKph25y4mjWsk7il6+Us1uXLB/2dYxbTp6nVeFlHQ5wyHGVDKMcIZej9BbUlqEV6lYt2KOzDV1yYORpX5sg1NauKGjXaZ2pZVkQ6SNd72BvJNdfi07sL+7kIFSIXCxU0lzxzubfnFuY8Gsz5U4zi/BtIEphHSrWFFkpqN1kmw3O0llNZCjI55JzEYyf8LdSVHMiqSBXVF8iG6mr0RwnFlKd62SlouoR7NBS6VoKpgrqqNOL2C2fJKlTtZwL3ZYrWssZX+sVoGnZ6yBgaazWKqZV5OBjp87SV3NblyApTeeq7Bvop5RNXSafIAfJ9OheZColx89G9PSYlJVfjytwpjCzcOkQYmWop5oPnvfenNoo4HKr7dIZEGIOYuYoqm9zW5IRtFKpH+qT9ScM5pTsl6zvbKbGruBH5xCPFqcJSfOTL3Gx3LOsERrO3Qrg8BEviLWPbeoaTZubFeTp09CDXKBkMqYuaxsQWeOxMfAV26RabrnV4o7kpmJy7A53qpPVqW5ZzR+kXw4aoxZskcjspOWMpeJzZ9qabt5f9OhqT1BTFQ4X5FPdIFVhG+TONlhOrokNpLPiJZVyEe/lG1BaKq1cFs3yIOyfWRBvXFRV3OuhpK9NDowhoWKZZ3DdDnVhHl0b3rWYWsffpjJSZhAQnS2Nt+lMY1a0Mx7X1lPcsiI2afGV7e5RzSEeW25id1mxWDIzmak2DfOjWlYala9sx/BsUooRmjAKdLSomyzuXhBoq+QQICNsHRteYZVQozEp7ibh0Sde1x5Ya2qdCWEX6lEt7qwX46YnbxoMJgsvH65eatsL6FzhWO5cpxylHSxSJBsUlWiwFWzqXp9ZpQ5pzainawsMMi6V4eCQrJOt2ZJZqvFTIvhsURpX7exnH120DbXnKV6U9JPmHmkMYO1sHmvupd9Z31msU5XcrRKlrNiybI4glhRcFF7ysyJJLJKl5VRyGaaTKTLX1ZSpahZdo24M6PTSoKki4N6rkPI2DelRMd2qLzKca1NgmtRip2IjjZChp+6QoWrtsU/YVXAe0LLrEa2djfeelmWek5n1Nxkp1bPZ4dZlLCObFWZXpYkUdilsMAsYbNMLVHCwbVLuSh+Sc+4a40YhpIxfVvLRGOylSlidC5fXra/h4a9JEivo8GBW4zNdk9Kf3s3f8FKebJeh7JSW1HCKohXSrRer29ARNpvdL2V0UFJoFV+RXWKpFttSqhTNIvGtTOAmjI2z8F7NLStNcW3PZ20ZY2TcVNhu1rCubphXjNFprt4a3uWXEpTQDmcy8q6KGzNc8VyuU2pS222aJjXd3e2HFtxdCWKodB1aX3ZbDy7rW6JSYNBS4IxvJZ0nmbUlWusSM5jP2lZUp17fa8s2duJeFJWiUahPzx/UrxnS5yvp6iCmp0tRpxrtLJ2oI+iVqBUmH9w1To9PHGJnqQ3UaxXXFwhaIZ/bIAyfm1k2+62ZtxXmzFCtnqIglBXqo9zZUNYbKlGrqK/s1xvP6+Atqpad16AcYeCPaM0Wl9uL758mMJWp2/BnJpJzNq7boLGzrmgcjdNf0poVVC1Q6k1UWpvk7VNMmq9ok0ueEFIN3bPVbqStUotYaBtQJSUtXx8izXVco1DQsZpfp+mSYeAZWpIr71LhUKlw4kqYHKgtV4ionqHlM09rrBPf4aKh6Vng36yJ41AhlCKKFVPyFq4V6KOjKGlVpWYT8qryV4wXXygoJ9VZT4+K69lRIthu6Vvuii6toKZK0p9qNFEV783lFC5dmSb1pMrSK2EujCnly1F07t8264pJSuIbmlrbqyfZYfNlpWYOGdarsOrd52DxGPAZrSbqp+mmSCwzZSypEA7cKmWNjeSS6fYZ5mKazhkmsEnoLKVX3wxqaMxbtWFbZGBuaZsaocmqJ3B0IdCS5Z7LR7Ib19KNGs9YkReRCeKUELIjUzFOm5Ey0fMmpCIopXYLMRIi+VLu+N8ti5cS4cld1J5kFqyJ6PFwtmdPHBfrqK4v2dhz2KAY5tHYb46v2Jut6lZR9WUj5hutnZkZm7NStebi4NmQoixeUMlR5qkpVIyZY+cxzQsiGEmRpBwurlnqxqqk8lq2ZKxSskiba+USqlUNY2Vi8/NnM1MS7SWtKFerFNioL2zXpqNuolUVWx+XdE40ZlVh6N7VqesWpKcuYWHq1svalPDcI17bWakKkxYga5e0MIuwnSXkpZhZz5ivS5Klox+SZ16bLKuv0d4Wbu9mDqZoi+MZ3mnfE9qfHeIs2OVU8CyuaOpxD+C27pqq5pirsBit2QwgTdiQDaRqXR+mplJ0KTbWlFdxJc4xinDTmuOtyKMpXt2TDpzurDKG01VlYFMMllqvCZRY3KVfHPSNEnXY2OwmnqhTGFyc4iCkoB1bn8WX8Pd0WqGT1oqfDDKZq7Hg3hDMGRdcWSQvrmMejCI0CaCwcuXtz4qeVZwqEtBmjqySLI1XTaRruyPWMzbaXBQT11lzmoVrCmmcbGXSnpPg7FkjaqRWj9Ke6pTrH5yULaPHZhVjZVKnaC6vbphRIPUeWt5RkWDm6Scv6prOjqoOosx47hfMj9UhcCQuGbAqdRbfpE+l4tNaHlqi6B6oKPLT3J/rMquyFCjUVZrtoXAslZdZp9XzDWHO0VTopWaOTZav2G6hV1ql1WGY3bGIrdDwi9x2NtWRjh8O4xBL01wtzPWs808XibQnlzVXTuoqq85zUDWa1JhVn1LV1VxTyvTOF5MVs6niTtBT8ZLtXt3fKWXbjnLtHtFni1Lury7ZkBpzkBIjYy0bRVZjV0qlR/AVtYxmF8yZJ1ETLNOP5m4qHhtSChGVsBARXQ0kJ3KyaotU3VeTWvbbKZTTYXLTolBSGi5T+PUmsF2VCdUXqi10XxgbG16iMmdZElBkNuzU13Alrc3Jx80oZ4qfoxWuNaS2J+Eg3N9VDKLuWuKY7AgN6BhwFaUdZmGa4tyYiaWMNJklkp5Tn+opp6zuVSuTNFHmkNtV7dxjbIkW5KzaFhHr5ggfFafoq87nWhvHaix0slQZs+QgpmPR6FdhW9BQMc2TIdESlhiZJSLtDuqmbOGVrdVfkIxZy6pkYrBJWeAdrG1ZGvXu5mYZl5+ZjGGk0LLI8JyT0cuf059WpZvzW5lomO6RC91ZjvVzmaOSkNdvM/JQ8abTkyYxdkzumvNpXFAMK/fVah+q3VypF7HkFq8bCVFzE3LOUWaZ6eTf407VjMuoqG4q7ZhIsalyTNGZLB1cYqsiEtJPZCuQkTNqMtFZVhcXpGdesjFoDm/YkdGyNBtiIa+sW1JmyWctqEjp2A7V4fJkThJ1VVbhMCwYmOkR0jK0ZW+IpO5r3NhlnxCk6Gij1yukyxFkIBDSsS4JYemMmtCXspQUoZH0jems3LPQpc2pHbRWT7e6V29QNqITIqiwTWNvHGeV23MQ8Ruf1jGH7WSQT2zp2mSu3o2KSdA3laXelp8gLigOCihzLMljEVRc2cy4UGgMq2Un6k9QGq0Nb8xgMVUlaxgkVlliIs2mVWWQrW+ek6aebCE0mdqmbFefHGpRSluKGWXlEVaRmF9ecI604iwgjWlkGQukNpsM620QojANFZfiU8hWKCNUo2lxhjBV7SnTcGpbk5RrSeesZ4uWJRUgDBsi4R5csZidE+6pL3DzEazNp52Q2eKaGmRUJ1qWtLOZ4JKV45bK3rSj26jw83RbnLKm5loJYN4gbV1LLWAZMhqtcdxarbdLoXDHK2LpW2NK9WepkZjR58eLG67dj9lr6OqWrBntHDKMlptujaOk8danz4/hV6loke4i0ubn9yHfdvRhrFaWOZ7ir6wp7RAYNZfSeY1N8ihjph7p0B+OH0m4GBv40RNtbGoel+MR7KXJmCXrrcgY76Juo27STKlT4uGnod2b4avjshfbzU9pUFqjDpPs5q6gHu3S5bfQ+OHmFo3wEWvh2O4PLbSVkFYpJO6b9ElSYjdKq6Nd0iXz9JlTpcfLJhysqPMh3aIdTHMeV9yga1ML4mjfVhbUcmDkH+WjmRmLnEhRk03nS+yn0+JoNa4qKHKflHBaYpHmHp+pE2lcFvBLJRrMb5MNaGfOGFIlK+iumNzw31xxKY9kDlXttKMVhzAnJJ2fyCQMHeorlxifadiUVtEd3eRNlJgubNacpJeism0tIHKrYNS43IutdHZRVPYYsdzlqNOb4Gpr7SmZXBkUliqTbB6pEtCNmp0S0qJvc01Xl+e8kWapD1owGXNyckqyzVFtV0yMI9gXYjELL4vfMWAQ1UyIExWq2dZvMZTRUCzPco9eE2Jeqy/t42UPnV/t2+QeIArdafCfl51cj/ZZ8xLeYdyl4SGbnxPyIx+kFGZckRExM9spb8ggceZuMvXelpPaVxWc0+VI1mYgnmoUG6v2VBHk7qLXlpWhYnGX4xpp6x2wbQ5vb+RaU1QXmmzeGlj0GB1pzt9RTaSmpXAtnQ7KXk2MdKBLFDKg8M2RnY6OjezVp5Tp2w7VtfKyjiqdEpBoIq6rT1mXz9YVUUqQ0Mkx2HSo6ZyuE6bWUCXQGShYk9nlGJHbpalczKdpW2fOVOFZUV6S599o4l6bD14nX9WlYbHS2PPi4xvXKAoO3y4hlZW1m1ufZJ6b2w/zWgnP2U2aJZNmjs/mLy/b0LQMrJ7oJuecDhdecmlgp20lKs1sYVzckRyidSiXItZNsuagGZ9k1J4OkpFtyqCzbIuorW0VlUrc7SYL9Onl9spsVY11oV1VpTFrl81trKsLjqyoDhGubFzS2tlTUBKY3M4O815qGedVb+pvr+ZT142SXHPwc61l9B7OM9RK0iDOq+FjJqvnF9Oqaeft8BorI9JZoWcfY9ZWkJ0pUVMo1mKt0XVQC9jqMEhwY5Asqo5YErKjdgyccCRgtJ/L5TAikc8Xs19WmWLjDZBNLSyaNFaqUxnrZx9zW2gopiqfad3pjBLl4qppK9evYChr8h/NFN94ZFlgjIYfa1bOLdIXxqpvMevXbtrf3VmQrBLPpErrL2ifDArWozKg2Q/Rn6sYWtZcYVlwWhOgyuGo4lPbMJZMGpulqNXmkkxKrdczHp8amigR2Fel2+fW7cti0uNvKinjJ11uKtOy2RWV06LbE+lecyOhKw9cMxpyayoo3k2coGOyLdgsDO/1DjURIwkj8VdstGa14uMUGbPh8qEQTpRh0VirnJTgSvVeN9Q4r55y3HSqjd+k3ktt2Kzprp0V2pKZKhpclVqiUanmodotIc/QEk4rUU1rHk1utAvRpujZnRcpzC+1G+fm6U+r7+Mf3+3mj6bmFI/xXp3w89PNlJeqFC7V4uiR3i7bb0fYsfCKIM5tXWGSz2dong6h2WNoaVtPma6ukY5p7NyQsNynUTEmk1HL5fCTnyZx51Zi6DDT5msvraKoItCQnzAXEtTSJs+dUlfvqFazllAOsgrnatLa3g0LpiRupK704dxpKpagMmlOHk+sY0xcV47OV+Cf7GHdXbQOk1syiO6rHx9uIex03Wf2MFvmVyjKtKcb0p012idQXpUY0q5Ski3mqCLiVKJlqata9JCaFC7h29Av3ZmimJJyoONgk9G1DtpL7GZ0p9eXrSMjLPcw7o+QcHMLKmafGZJjbq3M2x5vXZBlcKvTxg1tzdDa8mSjY+lms2ZUMamWDuHp6qQqXeUamKFcNJTOyhCQZ2BvplYtqhZWUvPw2BuUXOyummGpow/QECZdJ7laF9WrF1sk1txO46YZ7uFTmJYxZ7aaKpcn7CIxJJ0Z8cyhXyoLqCSPbU0XGxzeiuoU1dwcqq0k39KXsqFOpQ5zspCi8tBykSxy26AQHCJ0F+EWt1103wybDPIisHYsdcniiVk2DKIPk9jfW6fUZtcZ2bFYUo6tCSShDo7u4amPqCXpGjQuzQrV1w1UpFgpL9+vb58bj/ws6k7P2IrUSWRLsLGjpBouT14dmm3H1qMULkveVltU80gSjpiK1FwRXfYvqc7ao+OZJ+jo6lye2ngmZxWmbSNoai/PLUwNni2N6OFtnFtN6q6Kq2EacRFXneCoFJcO458Qop1cSld1ZPAy7nElSurfqbQkpNUzXCogrtoaGuDrLN5oEMtp650U5hPgzXVoK+SRrUwwMC1T6enTK20rrx5YFxYjlDHcUdRW0uYt6IcNaqaW7FvyaPCRk+0gixLlZdZcId0dWqbamErgMVcfrxhNyTJcaYsNEB0prKJycI/Wb3Go2tlspltbK6qXTsurobPkZSFpkmmq1Z0r5NIZ1A5htpqgrLCX5BNUMQvo0+ib0RyQKmZtneMMntaJriuojZeZGqlg82kf8uporG7l0Wyo7yoLbW+xTR1eGWuc03EqIlgdsKvTG+UX1y4jV5LvHBRXblrvExUiMhzJS2tcjGozjSSopmeX3WIlHpAjy/JkJGLV55EfKZpXTmLe4G2Y7WI5TV5U468Rz/JRDGsKkVTvkaVz0dPTtI1OkqcuZZBKzG0tkmRu2nNLlR4fZ6AejZwQCakeaaJkZpVZ2VbdmtVm7N0ukSSUkFAVoW2nGx6kFPRUGU9kjo4uFOGOWOivk59o8pZMMxPSLRfuBKZLnWlSdDPo21oWNxTN8ZYLU5Y0U6Grr+TxnUr0IzSvsZ6u8KBr7GlaJm6YMWjbMZ+p5uHTCK0ycfGP6CdbtV8N0Vda4VwNTuIbJI+h4VecLS1jjVZxhurlG5uZctmXa46NV1VaClAk786aOEv2KmWkjSzeUiiyW17cWCMT1OCbcJbwotRoDpacz/EWzjXWC6eiFqzk2dmxVqbs29nj9E9cDRlZFuMLcA4d0CKhoc3vHNJT8NtkSd2l8LSe7qDbcZ+mXjQRVRFbLvWwT+lMWLSX1o8wZ6gP6KCQp1Tx61KNzfNXSSsa0mbUbSIWZS+LTJZXWpHzZ+onEiLPVt+I0KoO7KvLEdJrimnp4wYLK++qcpsTl/XbrNRzWoxpySZuY+RSlVCh5WMrptbkrofZY5wL6POcFKxWl6vLSQ2PUdip4KmRc2UWjBTt3sxLWtVwn5Ch41FbWOLPCh8xKnaaotYk0yu02yPv7uQoqLKZbxhjnKDgbtLej2EYb3Ge6gw4tZ4wo0kjK1QgZCvWcRhLtd8vordR1ZBR0CISzh2pUSmo8u8l5xCq1jFf8m/U6gipbIul1U8UC6LvYajQIyr28A9jYrSbYStoydjTXNKrFRaZzfFjYwvtY2WLZd5eqc1z1tIPrGOeDJRj2arl0jY1Ko6L9Cdt3+FMDzaRF5lsrZYSLmrTnpmfLHQkVu/ccbGxKpvsdk+gJdJRT93Vcavx9ZTfJVtHZ+IXIU0g5qKmjtqZneWi8GmVnZx0NlGp5OqrWItMXLfQmwlmcRJZMPmTmNetztgfLEnOX6PfLi0UMFDlqtmupDDvjUxksbKhzpFKoErklZffLDkO4aeW9FKREu+orpKQU2cZ647f1tczJ0sP3+7tKkQlE48cc9pQ2OfdVvIyk7JT5DGOW55qYBJ18BzUMp3ZYJkwV+Zo2+mrlq6b4lWpcyXbmdohCxhKCnIJ719hKhEgXYhosRL2q5gQrpTvapwtINrL5KnxbNNUG9ylG1yh3UshLdMHbS9Vy93ozZRNr6Ysa+DbBg0eWGcymxKf5HUaKNuZoNiUS+1pSPQLK9IU0hAQL9eP8tDPqyyk7Rb04M6dkg3fVItjJWtSJujnFCymEt3m1xyU1c5z2HjnaIqK6m/OJa9RsNxnGG11oC+Pd0/v2Z2OchQPUCiY94/kKJONtw8O4/VfmSYOogygcxvaq5YeKA+al7GR8ypdpxDREeu3GNbmKeOgKHLtjmrZsiwM15+ZdphRWykpm9mxlJgk6prtcitfFWAiVHPTFRuiDdqYc6toHlzeyx0ZnK80IVkxlVTt84zsYXOyM9ueWdnZ7jSw9uV0WM8Zb+Qi4yTNs1GWr2Cvn6x1HCNeJ6jbY0lunYcVoBobVQqUDdIiZptg0dYg+JsrUGRo1+5nSd7GWScdi+GxJ8rbaynxd1aglNScXGXNKmJhTVxRb1ZoNXZdJavlDCvnb1PckpwUGHJxLUuo5rLVW5oRCBsrdRJbK3ILbhjeXc9Xn1FYkWvpmyV3LRGSaKrOm2KTsuLUlE4eFknsi10VEg6fHJBPjvMn0+ec2CRsmWwen6roqk+Xb6dpFmOgbnDt22KjlVRvzGhrp7KOJ28Tp86tkdgRtaxj4Y4IZJNxsCMr2+mu06RWqKYrJS7pyN5r8OxbEFmTXmwoEdqPbbHZ1uNsrAlnmmPtWyb1l7GwSsqVtKIcnyjuJ/Lg4+DLT+0O4Orlp3SSG1WWDq+oatYq7kvaKkve35BtK3ATGG3ybVLkEQ+roTQey2LOrxZzbxcuNI+wrGdg1gqJs0nlZdTN21Owa45X7o9irmwYcomedaFP05LRI5niy2GNJRNUcChoDlXNWzWlr5ZxnDeXZBql49rRmyYW4WXWEC+t2dHwa6sdXcnyVLHWENGjT1MY3TD1nmEPm/H05eOZ21XNL1dxnHRmT+jUpWRt0dkpsq0QjKfSYWfI4MujXJw2bRot0dTzqCn0F12Rq1aNEtAU5rKKlMlLJNyt8uETzm/jidonjiKfV1lc6qwuFO8UmOhP6COsbtGY2swSKzETntwiYucVa2JSpysWUNXTL3TVVyIfpbLwJVhX6FyNLG3kZmdk7ygYjpdPHBai7NKhS+thrCAXoJDXbslxy4ZLsHTUVy7q7Ohjoub2LNgLT9Wz1J55oA8UYJSzbHIOjWMRmLKuLvZTLdroHyHiayLytN3aZ5+VIKyp4LfVlNwdkhifpSb1GOXgNaHcEBx22JMrbdUbaOtYY3CrnCLx5xnPXN8KcBRgx92PaihbJJjKrs7HC55uI2JcTB0iVgvN0B/Q1q/x0VQJZBZ1U7JhoF1Lx6RwG04n08dnjLGyD/BQW9Ux7pnYV0j1Hw+XsY60bo3xWJ40SZKdrRD1rQzq6mSxjtxUFGkpbfDxJmnIV2QadpIPTw4d4mNm6XTcW7IusGiynSBsaJfqoFyWpxER0ZyqUtTOaPIkbY7uKZ+Ts8pvkLKo0GRyJIyj7CzgrBPdp2RpFlVp5yGxkNMZ14ypbNGs3x7R1peo0MtttNxRHtfxkptlDs9a5FLg9MnfZCffX+OdJKhZ02Itkd+n8VfbykwTJ6yqWDepbRIbz05bHhcncuUVxyisqTK2kc4n0i0aWC5unZ0N0ljypE8UaG7uS6tODdYUZk9h2uqMImoxWxpzojBjKmUOb08y01ObTJzQS+ff8h+vJAnj8IfkcJdyYlGrby9dL2jMU9kXYCvPoOGZdHOjKcqYYtvksFseHCnz6uLarxAT7xqhIdgX5+bVXAlU5mkO5BAipufk02mYadSpMA1ozGxb7k9tFJbny19yigsuDrEYhw5Z4ZXjIdiljJ5epCoP0NM4uk7jce8tjGNrEKA1qFzs3WGU1Kjt0dKkLOkz6wxqS93q8Mwe5BXPmzYyaamacGWxGWN1rpJnX5uM5vJqohIQp5/gWA0Uxiib6uPd4LIcW0rr7NjXZRKPpNdoXN/bVsdbG0ihsXAeYNWMXm2jpi1tbYuJLJ4oMSAtGk+gJzQd9IvqLExJ2FkvF3WRzNCuL6nksI8VFmXoJTTe3t/OaJAc7iblivNeFaukruU0V94PrR/TlIeUIaMWsjAqq5aNGutp5CdTHcZtbV3UnG2j09EMqUxhkJp1LrFvGxcaumifYierjkpcs5rnGiHf34lQY89hDvCvog/PS2L16lmhi6yqN2BQbozSHa6r2mYSKvTd2YzwWG4ZD+ViG2tiD1rxdJz0k5cc29Wu4eRNymaKJyaTFFH34Ksw0JIlYq9zTs+n2tYvG80kUjUgS83JrBAcsJ2X4OGIG86oG/MV6tAmplda9nAUE2QymJzsqeRgqiSXl80c4eVuqdNJMbPWcZDUjA83bKmmCjCziYwX4qupU2Jr5+hi8GWOVUgk0ouko2BT2OIhbl8fTN1SXRg065WuzwxgMfauT5oZcw2xjptN9ZKMYqEUHSxej8pLHN2FcAYmWc+Y3bGXKummzNDaldvT3eSuzPDfaW+JSaRlYi1zGaiMJyRT0qJr6NWzZHGnHppoqlBY0FKqICtl5QvPYJTQYxlp2GtikuEgWdBVkCgHx/AI753nJxHvaw6S5+Kj71AcHtjkl28ls3SmsNMOUy8j0tH4V9jvCwlP255rlWmNmIjtbyIJ7U23lp/0s2KdKWOOCukhJmbhT5nt0C2fihubnCdgMIjbUaUJql3TaWwLCWDerqNUC++jm2Dz0Z9gXylfq2eatBBZ6VSeVOFiXNqNqYwoIdQbTjaQGgycDirVkHCUuXevH3BOId6TF6BjHB7nj2OSXdRoYOROSGjSU3WiaaXqLUwfoVrzHGrWa+3QXiqTUN3ho5FbmQqhHF1d6rWLr0fvVuuj8PHTadiRGGuQFxMTtlIx6+ShZ2wci2tOcEppm+4n516ko2ePaRWizBQrZtQypSvatjOLC0ptrq2gqnDbz9YQ5Q+R8nNvml1cb8ut0iOnKpRYFyoYik1zZdul40+WXh5MDWlk1K0x5nkPTSZhIPGSmFzQqQ9naWFhrpe0aCIvU9DWjxLtyemspiIkMJuUTixTp6Nf7dkkq1kNB16kn5OkbtadI+RLR9ZJGaJdDleg2SCbp1NpT84QX1WO5LFqsE8R9G/N0pkf5uKgT2OOsl+q49WY3XAvEqvoYieZNZEfLMmlWMzyLtrhZjGjcxKVkqJX7t6yp2nXsWsObyHSCSukowxPYOzVJBsP1rddsRPTZV6P1LGQEF4pa+GPThKZcilldZglnkpbbO7iytLgldwvYORVzvLi29Hc69xqjBbqyZYUIyG0GBEYFrGN1u3x12bRIbEm5iYQ1x6SciVyBt80Xlz4WtGVme4s6G+o6CLwVApe9Cuwn60Pr7Va66hvWWYVsqDxXAwxCyZfkF2dp6CkSi3qolQiEBErpFHwTfVcFWRlC+wO1KSoyfPhch1fIiNm6HM1Hs5S7CVTIBdODC+0JI8LICjrbqQaDbOVYR+dJOBvYhlUJ5CLT5ziSZMple3MCldosNaPGSpao+cqBx7lLxAvqytR3zNyC3DhbinaVmTnIVsekVwNUvSUbVCJm6ujbx2gzHQrJbCZkmjUqtCSLk8OlXhMHZNl8aQpzvFY7d5oIuNKmdlQrp2jTG01Hk5O+BdjY+jU024zFCJIc2pSFTDa5jGQr+grS0ltmiIbx2RvaK6ZqgmMD1sbF1ve141ri/CUTB7aV7PO0A1SJiWZ05/0LhAgX1WOoSxb428o6FZkMRthsi3SLgoSYtfiTeQN4bScsu1ZIQbn42pc3w2oN1zwdB3hYrFL8+zzjooS0QzpthQUoiefYGkf6VgREFVetHIJMJNiJB72Fw623E0c3Y9u1yJZ2NQNYOcWtA5s89loJvMjFLCkW9clpaYs0QsT0NtslpCV5s5rYlOiVJffOilUDxNkbJfxmR7NWtrkpLJa3mlR4gsUod7s1tKbHmncjB6uYCis1TRh2eNLpPCaFs/b2ziQ0JNbnhtck9uW8GJjlfBrblzzotGe8uhfsQgN5qhnUugW524U8eTN8KknKJBuHLMiGqGVVqkeSbDTJtoX6aCuyqlzstxzk3CUovLkJepsGO4cC+0uzswTkY+P4iIeqyCaKk9TVR8xaSVb61To2F7QFReRH+GknKMykI0wjaIhT0pwyjIZrqLxzE/nnStlX9FmM28iXG4flLaZ8moas6VSKK7VFF/ukx8QFiySUeBt1+IqYQ/qatsl7BsILU+yHGpU6HYSTd/tGKwpbudh64pWVOxPIJ9pqBBL69zPkbmiomkvZCMaiZEmyyBNUVErFnSaZHLJblXWYNUTINCY4fMXUmehchiPoPChqeWs8I5vl/JZjqLv4BwOtVXymSWs7tNnj+RzoKXfIpDw7qZqt44pdNmga2dlaKFX9s1zlTSa5WepkqIgJF2R8OQPl+hoz9FqGmqyFRXtFx9jXBanIdpfp6YyGpxqplP0qh7rbw5oM+TVZBRqVCls7Z1S4HBVJyXtKtOvX7JMXxiU7CwgbPLwVTCa8qgY1yRS0jPr8yGsuhpcDvVyJ85UK52UFcyTa28cTUmhZ6qXcVYoNPJWU61orCVg4crv2S1tYNDjdZyklTEzVtj20RniTmBJkevvDOh3GePxW9anKp8oBq/v1Myt4Kzho1SKb1ZvrZ9s4R+QEW8tMBderJTfsp9ax68e1KIhDltOTa/rhemgntqz4enFnEfvWaxNMFpiq95n22pLzxX56TVQmBamFswjSqexYWLM1l4tTWGk1p9eKEivL07tpR0MVaPxcx2MozWupaVTrmbj053kMZgnH1HZT9BQsoxgarNVFjLYVKXcH6Hr0u7m7J9e5R2k1rWoYBWaSajPW6emSidk9N4z4qNSmZwQDNkNnN4Ud1iU72jp7majKRHSatsKY2PvDBafmVfp2SCfjhm0d1S2lG5diZOSDGCL6I/Rsu/f3YurZbE1tyyTH2Gtl+rUqciokeyKzK60YBS2FXUk6KRLGaHc6eutsi0TYlRbJMfSZrFXiCWPW2QOXC9bTtvz8NS1j7NQH5kyBuojRtIM5N6q5wyb9FDnm9aop+rjneIciWfU1tV2FhQPagthVhRdM5Xk1Syqmy5krirr0OnglBJZl+xbV+8uDdfgimNpJyznchsZzPWvmJDOnKJXWCEVU1yhCh2iCy3t2VEgpJMMo3Jc8bfL+AyQYh3R6Jlvi6bUN1UNL5siG9xWm5KSV3sscOqY3ZRPpYyqMuic1g8pBmaTbiqvkddwdXIu0oyr7h7K3dwktlyQY9Za5J2cLVctyfKqHycx2pbfDUsxOFIXKyVxZ+6gVNrmCHQUtZB2zmiLjadR7OVYH6eUWjJtDK02F20nVC+eM2GsJ+yqCc3oNqNq5ghZGGPtkBtHbtBhbc2vTaqJkd/ZJyQXTZ0ZWtJQke9OX6vTWWEQ0qaMpSnwlcybH6XzqZdlVGiOpdETlSzpUecOs9tzppof9Nnw7UcerdmjliIRq5sTpM5nbLNP8ujy45Cq6ZhXGNHdLjDl1RpVnFWkYpCqb16PciFpIjHP11jYDLYOJ2ih1ttqsk13FRJPTesxGzCpC3ZZ8A2itgsfXTAScGELME5L5BGlb9haUA+lWGwf6yej2SKl3FQfjtzLommvsVIqz9dgYUxQL2DlzitpUuwZcGOLY26nVejf2RoQ5i2W4mJvy5Z0KVFqrmoSrJMP3vGjYeZj79neiee4MRBqEPcxNKQnLY4pJosaL9tza90eb6nRLVBRM5IOmu5xXuTu4KPv1nOeVqFMHJ9NZC0Qj84f2gqoW2BMoR5RebIczyDsp2F0qI2qZ14Y2x6mbDAQ4o9dIGvqjK8fIbMm7p2LZd+uLBAIZ2JK3a5aDROdHPZmzeDwZSGcGhxo4tdW1PJJJzDotGAZJGzYKbUOjIfroJp2FmbYWdoXVJKP3FwmD2P01BiRqZ/zpFMjTeDwHWzMNSdf7dnQoZuTZWXh5GOrUONx1dgx2jdmIdPX41ycrJPZ7adPoy7O0lCZKZsNioxwnNVhXuzaD7CW2Gyi6mSioSzPkl/vVSgjn7YYC5xY5d+WJZUpTmUmnwuzX3UMH9nRDbKZGzGpm2r1dZ4SkBZV9l2n7KRS2S6MU9N0L05rT6KOF8/OVO6NEPalI6OhNLUzD1pNjqdT8dgaYmFX1mKxU2KQb1DYMu3gaqDimBGt06zdBKRP8xNx4IxR1yUs5s83MVMiTOZa7CdqkQzWF3RnlqYtEuSfaxJhqpfpc86yndUTjI0SJqRaThmqox5ToA7elvJZrktxWrEYqFD1FPCvVKamVGGiU/nUk7tPVXOPU1PcmSyYKamRX8/1Kmnt52XhzNuuJ+xOHePfHykz5xkP4ijuaUsqlluLGxVnVmrYFxkz7JkV1zHdIY5r3NcVVVqYmJqqKGOWka7SsHIpDSGPVOWoWtEM0WYoG22zVMgXrIro7qQcInExl1DUsTZM9hiVlNciz+DNWyQVZlq2rugZcZejpqwS511MIm5yXuDSEBtoC5Vc8MphGFrfIdEPbKPXl2Zbr2ZX7SQQm9mU+JEh9DbnDtghDfGL2ovS8iAb8+lgENSwEmygUVLhVt+MLLEgbN3W4qtzXOwI7KvmXqqXjyOrV0uqR6GlkWINlzZMk99YmqRJaeOMsvGTGhUr35DZ0nLwcBlMplFUS1YW43Ddyy2KZuYebE8h1F4caaocmWmRjIgg1I1UXG6oEebV1ZaM2QyJMWCUlYmrDXBktebqpOEvo6HRZDAeCnINbBHQMtVR5pWfzZojIantUtUzbStuaslvM+msDvfT2xywC2/WYfVQVl0dbbSdUC2sVVbYC2xIRxwM4RHpkW+gIV3YmCnecSAqlify6ZlKTTPVR2zgi2pvriTmWaLS68vtFB/jo2zWTdZk3yAob1vlU6Gp1Wvjiw1hbSDN9RNvEW8d414s4yKQJK1ZmNxtKJNaWCw11KlvEDJImmVcb5xzqqbw064T3myoIw2p02N4O+f3YLFTzFR5E5OfFG8cDlVJLJVcbLGIYtoelZKaS1GXq/QXDCrMqQwv8dVPlu400nFa5l5I1k0yoY+X0aArkhmytJYMpxCsqtLcTiAETI6TdW6iJjLOhepjL6D0EUnSM4kO5/BK6zDIUsnfKfXa2rVcVh+vXoyYKmdkZSspVo7eEZCZ3l5qIZVP2Kr1jSbJx4nU8GgT3hquVrTk01BiSiyjVyoudJvbJ5Iu6jFKnE/2sHaVjJhz1tKT1WCS0zCzro/PlzUe8BlmGKWQTtbWVGhW6+rfjAryKlynDHYWmW+r5xFZUIfrCSumElEiEGkgKm4g2WNdEGWtTZTsa9XZnugnzayc2jGXUZ+PJhexsGCzbolNcdC1YhifXnZ0mWZUETQuo/IqMuczcUoMn2UeKtOMXNDapy6tr2Dmxp4VL56tCh4KrB4XlOCm5iwrV2+oqFNddaHikbTOV5KTT+GQr04by5AqnWlzjRtl9w10TmifDjNjZagipiLfIDGX920MlRfeIY7NL26o7rLiWxRO4dHyLp/kJyYgjhFPmyWwsh+WlIjpLKAmbMsqx2oKtdFrd3AeyutVlFwZTp1U5WOSZaNlTSOfzJnj5VY3E7RVMq2M3CwWIM7sHStt2zKan7RbjWSrytFJ2uZY8c/1IMwsVQynkxZj60rVMRcuFNomVpLi4ODxrkgoD58R8RQv4y4OJShwmMxtbS5z4a3dzNLamRgjaNq1p1JcbK5OmJUfKaXhKE4xHiALNmMNMg90iJoYnIu0lOPKWO2RmWFq5PDn2KTjEF9ImGOk3nEIiRBn23BIIyyyWvHL1cqinhUqFbTt0VUSMSdrnDINMdhVr5Zxa5ml6+0w3IaKNV2QjJCTB2Bvay+wlMkR9CQoVdMO7cjfKC9zZNof5plHpA1soHMOXrXPzlLljtCfmG5l4lcSYfKjjGBcyqcj6c7TsM5m76SLFcuzGlejD6nM3ymRUU0hJSvrrJMjDaGblegKIWrtoXCuUWExkaAub4cvEqKLXeDlZGCM0dtYmqrkJOwa0lCKl8mX5/ZsNo8P1DLSbhjj3k207Wtg5RQvNpIsIKUuLOqsIx4h2y4gTJyxymwopB5hicyxIDFdkhmQG1nOY9un2atTT7lYVnXxs+Ivd3YdTJLjaqPnyyoMkxxcCrcO6FWi7FGljVktx5LPnHWhpIuc2/E0TjFXqV307NZGrBrYVDR8D9EPatuQqbepWN6rH9kWynKgDSwrFhekLmxkW99sWNDoUq9Wz2+iaGCvMJsY3rGs6y/UdInNU+aM85ZZT7UezVEgbiPMHBVqK00nWlDUVPZR8F3zSi2htO4j62yzC46uylZWYc8NHlnQHlsKa2tukNEMi9Yf0SjbXrCczrHx0hltze6jzVIjZQ1nzulvq+HV9CYVMBEVYNfkltChzOLZXompKZ6lnjAbTvRo5I4Sce3r37KKFKqm1xdfXxqgW2keKldv8qVJECHpaecWZqqyZwaomJzX7bFTUNB0F1ToNBfJtSvxWHAMKW6f1eKI7NoPTvjbYxXbVkwpZGptc+gnZpDgn2kXozAMJp+ocGvva6KkitbjnE/UUlluD+0tD6MOqtwpNiwK0OL1K2VU73PLUEwrLuxOmpNHb2MPyel1F67sr+AokapdY2ioEVHxLeGeRy4ta6ou97fS5GksyR3En/XbOlCT0XFtFlpn4RQ332CObu1sF1uSs6KQVt62ZWnb7fVVrVIV4eKi0dQbnlLq4NAQoO8izBN10DVzV6tt0mNLqq+mT2jRF2cY84mgZ1WzXybOm6xz3qROUy9yqFyRWF5iGykgVzeWUWsXWyYj7u2HrWHj4eS0o/EcE5WQKlf1obOLD6utpPTkmU+opBlR8hsmnd1Nz/FrqS+zzy7cE5NcTh9sW4sckRk2Gehe3VwO6G1kyrY1SMzgJfNZS58uF1+aFyLfUZRj8J1lrWZZzg/g2nMqLBEzZOhLjQ+hX9xyplhpMG+1HNnMyuduGraxG5YtrlARsphkimeKkmTaX6NzmtfcVM0ltlHwsfSS6i3RWm5LIkjksMrPbPBwDhnkmNIXOBvMkBKg0pcZz3GxcZBU0dSTp5/o7nHgzfNhIaLm4S+VqJFqV9fqdx4yWs+bqtyh2W9R1kxPtifgTlJ1uF3iKpYX1RNhau8q2ykM4mzyrxMJ0K2b9OYxDWqUFZNnVGIyj9Bky68eXTHtVY7xnfPP2SkX12pncqfMNbTQr+tWKW1Klk+k3bCP8R5fFinfqYkeJGzzTmnU3enlapfyMXJgzdDJ5gle0bXvFpfjnZ1yLGBSrI6YZytxE9AhoiOx4tzN5xUzGO9m2OzRFbISMWrf5JFar06faN65FF/RLlVpcU3TKtNRJyFUIvZ1q6cOjJUfZdrQbPZmc9wbjWwopJgaT6DiIxjQUmAaNpVujtgpLmtLasdaXA7f49zejxAqEhacF/CoFFrvmB8zYJSLuDUTVa3bijDc0yRfnhbZLU0kFBkzD56Ty3GhUGKqXeoqLiOlG96oyd7YbU5LXKPOrWhNihdn6y3yjomUpaydKiALXKrJD52gCkbJ7ltvqN5jmG/6t4vQ6XUTlFsgNNBN6esqTBeU3yGnbYbwCBGw4jJSHJ8pCRKkcaBnrwxaEN3HySEOIDLZIXS0r+SVZTMhGWLiDlINr5eWI8saqNXfFZZcLZUyp5AgFMwvr9ENXt2b7iBrMmEc67hXTSnK5YoOcWiQK5/u8XKmqjRTaOIFkZqh8OnPZpzqHqhi5yNyZ2zkzueaMFhSWE9d1DLoni2PdR2d27A0pGkw2lCt2q2TG9+ioOas8Ktzs1Ec7VqpHyTV9h4p1RukFU4pI1YTr7LV8A/QtfRRXByrbxWSmmnqHGEyDs2NLtiNpNoVcFVr46Sz5BFtj9WRmM5o2+eKlwwhZGYph5uvCyWjGdoQrdxhMdnFm6MRibZxm6KcJPIeYNDdUEyt9WgzMepzkJV0lyWwMGJIsk1XcDTp1h2snB02mukvjCaZoRuak7QR1RFs60rx55j2C1WSUGScJS/NCjOvjExf5VRxOI3WYhS3EuMToyqv4BZqKx5ulpWV6I5Tp2FfK9Ge5M4tktc51Nbm6PFmVeUGpGfwKotVmNwxpGOu25ns2NEHjN8lLuVNme2eZOtVZlUfbhPidRXgExayaF6MKtpjIR0v3EyeJAxxHdCymEiQLOUWV9lULuBhUB2kW26pW0pqJG3fy2+wUwzpqvDajJ3sl+8nnXYprrBJVuGZqaOiVI9tCN1pMqNZpRiXT+hs16NbKbks5MoPjBcg2WH01FDT7y+c4ODTs+OIoBJlVm8aV6KX21gwL9fkFJ2TXbEVS6mjEFFM8zQv76mbk/NRpyqVSd6szC3yMojwphgZzyEytZAnWSQgaRatoTAkUxGV6WlnIW3YVWTOzA7r7u0caihQLTSOHNJU55axk9QOk7Ikk1GerxSi0qdR3hlhoKrrSmuuzMpV1c8sTO8mDgue4pOM6FUykg7s7XSYa5zXXhcSVrNhCfHy7LKN69okVtIQX+5SjZtRYpxhcjCrnxqXL4qykBsbuFbh2+RlbZxLjzfTdCoxHiIVEG9QHG8mnwdZ7aVgaWbMaqQnnFhgl2Bak/DwaNzR3OonTtRZydjbaZXQ6mOOk5RbahztlMfa14rw8+3aWUsf1qARaTRcOBBhDCoJ7BtZYpWf8aQ4FFmPEgxVr94UE2/0cfMgz2YgMRBTK2jJUlZvEW8at1BtVA5oppQh1Q/cbtmN1fOfS2rP4qGp8ptwzx8bbO8g62+Rl0ykWasU2C0JjGIW4JsNitxXWY3jZ2By3utbXadKoJuvk9Nhd44bG1+NbWS0tBItWiAmyJKbrPJY4OfpYJKpniAX2x0E629PrTPSo1ph2nRqo6LMtyBQLKlJG9RyTmQM3QXFRmtr3TGNKs9uWhsaUZiWa9tf8/AI6PBHUlEiNWLgjmbOlnFW2AyQMxYVpywhXx8cbC8dJmQqkdOqU05morIzI/HbTCVTL2LqS2BMHa3pZiAljHMQTLLe5BmSj9xwSqLLXeQaal7pCwwXF3Lx8ZdUTtsdkvPYou7Vct+o76iR2hzIH+pfqdxYLqjVFdrm7mJMa+eQnrSv6aKws5VZZCLfTqaiLvXT7w/joee0cWvPH5BkUonOmu7UZFumiKnw7BPwqpLjj46X9tdqzmOaHBLYUM+M9CJv4hwP0BbLcnBOVS1yEaEt9peSl7JY26RcjxXib2nuTY2zFKonzyXkp04KlmKRotvbcJvnK6Dto22gMhjHbWsl4mzr7BqWu12iVyWsyowJKpbhW97z2yZS6RfM2aXjz/Jr8Y0Qbe3hmKlI0ZVNrA8qaebxU+8XGtcUKzJZ8qhY1WYzYy5W1JHplLWrmasrEVkTnhLNDVfRESw1XlKkFaFoJA6391AknM1jFc+s3CFfYuKhyxQqU9ptIuVIYKknF96P2TiZ1UuybncRVZ9tnxXtZJas5Y+T0SllaLYpbW2iNTLijGwy4NqL8t0z7d5O0HMVNKsf7FCL7HQxap7YZ6yKYSwTb4xlXGDYHRnZo7FpR+Tx5K7Y0JH1WSGUaafkWVPcyqKlra/ftSgsa2ib6+zZ6m9zJUZfZOxjF3JcZCdN6NZaG6Kf8dnv6chmXPC0dhDpYrByXK3qK+MRUqNTUjDm2bHw2R4hE9P0L2PjnGM3kXIryjMLkNDh5FsW2GYbY+CbMZ0yn2LwIk2jIvUt6Mlvl6OnscvmV/Gs056hb99UZg+VqA+gEByS5LMxJlqvxAZoZWKjVxyVzmnypwlFZ9BrUZcO3SNOKGrM2JBqKLGy7WNUE/PlYU5VGZyrCQeSH2ZgUnQWCp/Y7NcXZssr23UNkWbm5uxPLdLtZF3pGCUPbUnWp2JObjGNEGxcHpyqGeOvXa6P1qSi6S6mEiDP3zQk5BISE0vY0GKtU9MOtyNRYxLteA7OpExanOCqsVMPiqPWz2vY+Q+fEkzX3vJuJjKwjKQlcO2szGJilFnrF3UgqVbaKZUbYgbMGi6U7TUf7pavGVgXUSj2GevPDp+mS53elFVcI3FhHupaW1dNVFCVLozWZ+liVSOvTzaRJpGpMdO13o1P2phNs85sSh/qcOoWG1bs527oLazvmbFuxadQKJ0ZbyKW0BGjVSRPyzPmj4yprVyjrPU0zprvTRcct9FgFmEN8aNM5ZDvkDHll6auoC8NXFyUWdlclFVimtiN5yrlkNweC+7Or9Jk51f11tupY06ml6hzVQkn62ZkWGzi5F3pHBIRjmVOoeQrYYZvKa3OC+PKqZDgUOvPalgRGqsyYCDa6w1hC5ijMGdMKtLN5rMgHFtFrKlgXGNP56QQI6epUp9r9tBV463Y8EypUNTjjCpLlhZp8rIkq19tMJjfLB8p0BUJK/KkKVpJnmuLMKEnG17v0O4OVVFZ0SEy2ef0W2oXkJJXbquNjCVvbyzQlssitdhuEdse41qv3ClUFJ2uKQ61mBqOauRziZsIntpr398Zq/YUYFSerDHd7Cgy9Aw2XyuPmBU0zTJu5J6loyZhohnhkRNQbydhoF5vFAZfXqgaY6HtMuNeJJidFe5kV5ObahCX494QM0wKq5VqGaynZXGm5SgbsFtmpBOgdCjZGGv3DaFdcBwPoBFh2OPz6w3bmhsYjrNVELHcIWzUWq0gGFfL2fEt72kt4iCycroYERQj6O3ej3Lyrl6SWA9XtHQk71sLtu2KSswL2Z2RtCZSmZ6RnOzSVJAwKq6ptNZt7M3Wc5TxTCcOsusVpyBsZoveIdRX9C/RWhvxoQ5kq2MfY2kcTySR2g3lT5qm8KnU7u2w1UjnseKe1OUYMurcZ8ss9tTcZzQck+SQU+2Y8JotFcqjI2xKFqnW0t0N2F4Tjxzd5GRUzk3MZqnmYXIsLrARCTIXDI5uZzoQbB+UUBRd0FOrKpPlpV4Q3C0uUVbOUfZesBcY4Rtbo7J0qh3NKOJKsJgmKE5xLhvXUF3WKg1j4+upHdij8WxOop5N1RBM4VwsC25hrRcmWCpgnliSpB6aDu+OeBBQWM1MLprt9hUfEgtgMKQjqA+Pc1oKcW5vzxAXIJDwZ6UWoyGi2dvN4d0RRJfskXDkUzPnZlZcpcmbZ7TeJ2ZSDs5SWBWxZJciFawzItKltJoaJwpc4W8xq9vlGKwMqlIzHaCnTvINoFbWrKfgC4/JTVEwE/ET6S7aLJObb3YT59k1zffRc87YoW3PkKgNIebWXqAw2/LIprDTrjSYVtCPkN4uCBTSTCjjkt3RkUix7R8icp9oZxebLSax5hXM65yRHc6w2VadNFfO1KRjn6BnjiuH309lqYlab2jx0l+T3uQd9YqrTmNbkbZN55XQjPGQDJMg2W3PjtbW2WHmES4Qc6fWJJ9cmlXY0OTejZnMYJTs7MpiqzDhtGKTk+MuVOxnmyzWoLFxZcoW8FugcaehYeyeKGVoGyhqGUuv95OM7eUUYW+rntumHGxTzwxrWeN30gxNiayeGx9tW81j5ZGkaVhed42c5OMkZqqL1Y1doi/xDODQWWLcIdlt0QtrWhXpcAyvy9COEnWmJCziGPCyXJajlHCPqCZnipck8bQl8pDdWa0TlZdaHN3k1+sJq9Ra8CcdFo0a5E/vdZjvaY1zTfDXEx+J61NGldMTpDHeWNykVS0bqmhjSe1QL94gnyQz5qLc2ZMw8pzJWmWZTdTMJlYrIyaYF2OVD5ggFfbVWe8o3fAVmeH0C1mUbE+s608PnNLgCmHbVCecmfTS3F6SkZq1TrKWnamvbSoTHWLv0dfyC6ie6uyUDYmmJ5QPaxPxplqqT9insTGPCnCL6XMeGc2fJh5X3o8d3zFvGiRdLJ8hkaELXXExF48g2CezkZTlqXDxGA7nqaAiFKmjI6ihjRhhUx3W7Q90TJNeYw01WiNVC65gpaspZRqoqBK1KBhMLe7ead/q7+1yXWBl4U2QKSsRD5gEalOgsAxMyyqUdW9r5WLyIBPRXWtZ7a0nIWTHHCsqIxVlHZKmIK2ZFrJKKCpT4R7fo/UOmKYQ66oLYLAgVpWdzOEz1HBP2MotHJ9UZI8drWZxjY3RLSNVCyVx0TA1Z9hPZuSuo6EJy23n7yQMXWHRTB/zm6RIcCdUB9BmUw5YnNfOmuMVp+3kYijh35WV2iyNsWzKDKWzsZCejaIq62cxHsqcS9uiVnPaiRvsIjasUtnozAl19+8S21bmJybzJJJTIhhN4VQo7J3e4hFscmiqz7CR7R8Tnp6nibDI4raOGR+wiAkqmhVTLyIWpttoqPBW7PUg6c+tcmiYGswfKiuMW6/U0CrcTk1pl5nbHd5UFippI7Id8Rx0zhImIfcqZlyUVeTGrxGjzjEPGZClWVvds+Vhi65uZpsxky2yr6GiKRcPp+yklJNNJ2NUUjOJWqmgFS6V7PQoGbALI9SyHuVT8NazJ6gtkreOCdeLNHRo0ySRK2mIpjDy2kjhrGeqrBaHl/BzW1bdFDS1cyLVqKdN2mkh1RrRHCda5RkmZxqy7asj1hgQZppUiSFO7KfiH49uFp+UTNoP8eDaVuotaVWeSBWn2loqixqdjK4QWmMMsaTSy2Qm3yTuGJ7x814sDZkesd7piSTw1RNUMttpXCnvIQ2M8iKwaiIK7PFTyyVu6M5pmO1J86gipPaR6F7W6CeoaA7RqZqZ0+FnkBvt625X6Cvl7c+LIO6lYWiw1aNg2fcMk6MmkjMwYXMXrGWq4pn0C27jU24s5pOk8mnq3mBmlg7u9EyM0XPxb7FR8phk1yNn1SmYa45lFWZftU8f7VnaWKQyb2qZ8uxwJ1Hc37OXZ0nRotcdHR8lKesjr91gzlAH63Qn3ZMed1wUVrJRMeUOxZinalm1LaDOqiaby9qomXAMMmOlWdVxFtdX9GPUXJaaKVMhdcwj5XHKTIufJqSpc6/hjKXtoeTvVykXLOtZLOUlFUpwoK3xLQ/PZorX+LgTlBehsqlsIBWci6+YXGARtxTsL/Vm4WtldKrPqlGoDu9bypQnLJcrTCJt0txeJXBjp4avYBwjclfSE1BiLDTMtKQXaFHwbSJXnppLk513kSwRnazqclnwsCiK7aKs7oloh84dZi+zVtykcCbrM01Mkw6ukFEN7RXcLLOlXRdNTN1Wz67pUZcfJyUvRuyNCRQmi1/ZkTMbF9ocER5vanLacpITnmPMF5nOb81pzxjaaxKYLB5QZOUj8l0tWRbrb2zKTxOruNaStnWWJCcyXQguzJZjb2Xv69C1rPfdmekOMqBg4fCjaNQmlc8T6RDpGmegidDWjrTdU+9tnnAon4cXqGWeqdUIT5/lXTapM59N4Ouskl+QiWOykNJ0HCkXzVbuKBi0mZ7e49FkqNdt7eqeYVhPzHNtLYvRXQlj7Muu3yZZDOxNGOth1E+tCq5TFxsT75VRrREPs6OkJd7sG5RTkfNL7Gxq548kGNnh5xyYd6GhDdQuGlatyqklWSOPb6tY5xWqXqDO5hxW09pNmeLqaS3kI7FOTzMKjiMnKx5cmowLdZvT2zXP7epv0XLocRMksioJ4E6oInNJo9lTFFlKXCNwjF8TWXMT04xzLU6Prou1VrChDrQXNOyrpHPwHC8hkNQz8LBOby+wz/JU2FOaBsiHMSWxocfdnvBdDo32DiycD/YrKMbPNBQg2yQwZ5qfzOyk1c5pNFXOUPKhlQ1gYFcQseycK1LlIhmhpxQdEUuvs5yoWWuRjyQU85kO6ZpVa9Oo32DKli9TMh1pXJQ33MnkKIhxD9NOI9lbTiHkT9yytBanqV0h2OBXDy5ym5Hf5fceIfevKI6sC9vul9Au2t3sMiRMHpchcAodJnMg7iztdeTYtyuZoWBo0uMqnuMaIOYXVvYnNlGq39ZhYU2IZWtgF/EWV9Cr5dHw6qdvF1DWsW5S2bcN7g0NZLCbb1HhGSSWomrNSBbWZAqTsrKaGd4nremwcq/K9UnyMi7fXy2glOnTqdWW1CKNIgcRMOeQE5jjZe1M6fN0XugPWSfWrqjvydUrathPUpVtYNGfYdVdyiGUWBDP8EqdjwwxaphZYBsmVm6XjOBx7jDTq09gLfIqys8u6dchpqQyUCTknuoiLW2PHiwh586Vms+pWCYfKt91d1+Q0+Btnp5RrCbNrGuxl2TlLE5lj5D4zpTvHylfWQ7YkE6d3/SptFj0Galh3svu2fQay+kn4V9s6O5hmi+XJiHgWAwkZtMYZEng7dpkIW0NMVnzUk3xbdpsrrWvSp9fDhAZs9hSs8qcISnztS7vnQzjjeEc2uASEiTQyqJpHYiXDCYJC452VHX2cxjjq+qoId1ay5vaZeQFqtbN4pAdGeJVo65n86ebJRlObnRcmVrnymASFOhLWyBzJ6JqXjNOlzYf3CdOaCquYNmniHNg0N0qp+kXELagYNjy3nJPd1QYZc0OTqCQVlnk3HTeM6atY59k5N4wqqqir+rNmrOV151THqWTFMvumhOgdN5WFpFlJ9zxrJv17e8wj6nwXmCoIVMf2iZcEulZG83l5l2mFl7t4VJ07NfOXF5jMk1aZ5Kz+GJilGpmlNmYMS8t614hFiDMk41t8Ezwk6AgeGzzo52bZG8zjYqN9PRXWiijEjAhB+gVqGmlbtdaDyLI6ggS32MQ2Y9Rc9mL3Y/MnuDf6KUZZ5SbY5cgcaot1c/qNNOjVySeFCEYUCMRdAaxHEi1HhtO66QQjh+fIimdmCvi8rITdWwh0fNa1RWYdmTjGJlp5xLrmvBbS4sMjp7bta1SamXJMtVfT28GpFNu1uchmlf1msglDcpLY3YxGibxzNrVz/geVJYnKCdYlBMXk2WQ5po052qukKCc0czZTRVd4Rjp+1RSl88z5SUQa1aJFjKj2BPsiuaJKEitLCeVEHEcXFgs6h1plBSmGuZnL46viyj0i4pb6OjSW9/cV2KvG9kWrdWtnNCy9F8R3WcpWGUoiZQ1bJNuTlTrorDXmaKiIKbN2RLSZY2rEkykmhey495V6K4vnloVZBst4/KUVKzJzh1GzQvv8xZQ35uWqdvg7A9iHPEkFuRtp7WtZY+OkTFs6Freka5K0mSUFOxgLdplrU1VMi5Ods3riCRWzUtWD3fQ8bXjHeVTVlDX5BClqp7PbjAQECww0g0jCxyiKzEf3w1rZC4O4eROJpkRtJ9gj2BazVXlW8+d02UTXhEj4N/gpm7K7g6iKGOqld7bOFsNFkrQsRVX3MyUn+1W1Sy3IRAe2c7pDyLyKTFwUalK2hswdlbYlDYe6xINClenshflVh0Z58sX7U3wkBfizR9iHCTm14suK2rJGfKfcNlSISIV5qrdqpgc5nGa5+OVS4qxb4/a6S7QNtcpIlhOVs4g47Fyqhme3Z/REpejqi5QyyDucepq64/OM4+lETGZ1lRd0iUaJzPT5vPL3ZOrXElR2t8qzVN0JZdlZHCcaKhtiJxj584rViETYSkV4uxgp81OVjCfFDQsUqcwYOghy6vc8BApmVZirQtSs4sSqJzmr0wOjaUg2aXyoPeMDIdtLB+NcpgVp1ieWjYUZsnvptEcJOMMWdZx0JPLLizZWJdS5mLmV1PzlhKKLpltkxnTmnGiz9fTKuNP5RKxq0wXVmGctBBXa/JYy1bNIZ7sV0lio1oeGqFzMlzjEI8gkG0dBq/dkaJtMuoY0hf0YpXpilpwku9n5s21jCFTGG5wMPDeDl40aYzrbgtm7BQhXF/QZeZHHY+YkuXoaVWeKjebtR9foqzYkCJdjdyaJfDvEFqol41xVJppcCgf1GDvr+Kb4qmxnjBm9k3jt40h4GwcKp9HTyEgsFBkI8ysrV+LJdnqE5poE9YG76zlp6CW2hKvIKkwzqwTnIkLFNeWW9vucA2lkSkyy2Sy9EsT3BcaFTcRk5gqMhLqWtgr1W3uR8zT1unQfFxPMWMqj6Ux06OLladtIx3vV68QWw3hqM1ZlNseF4ui4J/q5WOe4BVOUfJ3oBVwIouu7QKT7Ohu1i0XGehy5bHUGAxWDWQN3KKN13XnLCHur1hS6vAm5MuiXC6TTnXb8IggiF6j127O62tyHtIQNFTyIMfr6+rqlDPwSBvr4OutMmtJoelUcY/R65MqZ8tTd67X2HFvXW1qURLYbooNkalwqQ2ejpcilumuMtNi0ZlYamk0FWdVmtsNsE0pJCkdlZSoHNjsFaLPc9GWXirY7ijaIJiUHtbOJe/xrS8obs/PY5l4k2iSTOiq3xokoG8x6UzfjerspJGuDDGO3utuJzXWU+Jh8FcklnYv2BjrKFLrsg5zISaUmp7nWLc2V8zP8G/uHZllCa2pmmasXyHMS2qdnE3hk2bb7akYH6rP46jiMKqUUty0XIypKXCnk44c0OfSljomp6Op3hkS4zCWjefXVydzoI/ZZ5nhIFXxKXGXpOuxVZJfkZ2QYNDXFhLNLR20Sa0IIe7YJOJhNs1KkRSV59IbDF/nV1PfoeNRm6lWE9XksmtNm/drMKCT403jyBbcLR9XT9qyXOL3EBLfWyZNKWzILKutXNhzJ+ZPZ9TjcXGwF59z96bbaFDSa19c2BfLtSSYJp9yotJzUJURXGSQcxJryF2jB+SUnujrUWsTUFkcLl7hWlllE9gR56nh4KY0HFLYeF1nmWy1VOpxNszMl1FUmfOjVlCj6lNb8Q3e6R4cmyWjnQjm4+hjI1LRcJfjkiu0ItZoKhft1IroKxlJ1kwcEfEeHuDzLebwGkplH2oFnQ6q7WNwFpbi11J0DSmi0+4VIaxvDW9gpyCuVWJXjpMvMpO1jPDb6OJeb+1dthJeUJFgaPbOqJ/stB6XG9duICNd6XSiVq3mVxXvFultcVzz0uDqiunYDZpoV1jkWWohVGzvJ00QVgvwKG4a8qedGlGxLOybFeAbqOGnJh1ZqOrmYG5l4aHN5QZXorDzGN8gIZ/jOJQMnKCU3C2fkJ/QX4sPsCDlWVNT0t6mm+djZFGPcvHpYuqX290lGU7tL6SwrSDoz5MxlNsqVeEvJaWyzSQpXlKMtluin+OGJ/EOcdJwI/RN0S/KsOuNImMX0Y+YlZlbKHMQIUyz7CIgLrIZsNbjXqxm85WsJ41R05jlN3cZlJubjhFa1JNamm2fjbGj5GWkV6RiCpFtnXbxnydtoynobZswDuyrE5uJbKJhot7YL7EYjjWXzGYzTyxopY9wluPQVlL0jJ/XDeNxn3ZUMg2WZvEiEkyz69Qs0ZWTKeDd145VLfXd39ElLVvUzBhOm9uxYFzr1fGyGbr6j2Ed3irspdcwq3GrNJmPGKyx4FaPaGoJTxXtVFgPbRFoHjEk0KSWe1eanE6dz3CjcmROqqRR7WxuZbXnFZAzEh8OaQtwLOzkC42mHJdqFkyWkR5xqDHQry1R8PBMm3Irrhqx3i5Rlh9jSOxozlIX1ydtELDXFhuQsWbN8F8SDpuizG/XWljLZE3zEG7oCBsmzFfoqptNdhqmYAvaVuKoIs5unhqOUWuRUhkomTbKq1OYi98rJSzi4UhVFZVaaJVt1qLSUBUnEQzlZ2zVKVSK7OlXl5AqnnTp7B5XNK2lJErqHJjjacxrYZXs80aj7JQQMt1ZqBxmEN6OLNibFq2urZ/opzShZVR4HHFYZU7i1JiNqxxmomEwGk3SUqajsSSGDJ3KoeNtl9MhkZ1z2tpPlJQuEWppbc6i1Z9ol4qRWtBicJ6s0w2zapLir05Y7yUtxKUiUlkvahte22iQUDKq9Q3uJdrRrJfjH82dUBsyFBFvZs/klsrNMShP5GFz7vJRFtrmWZhNrx93mNeWJusMLuSaE1wUpO1N2G0RzyvlrtdRWw4zFWmO2ONKEOkgq5jm4KFmTudUWckTHJxSbRlrGacwbaRmFJdrKZUpsFZ01BRhJiTVmiTbkcuzJKaZytDWtRSxCGpMcS2hK0zWoLZYqFKzMJwebG0FjWvN45HY4JuY2WVqY6IWcaehkZSmW5G2kmaSMYyL1Knl71RMqmdxkc0nINhY1VJd2ZF1dqLZyhGPU+kM7nOT2TUUUVsfnKBn8t/WbHNnpKIO80uWn44vo2Es1fGJnHLgahdYppAnM55bKC7NjyZrkBFq8drOpuovUCSo6KywcWqOYK7biR7j67ScWGwl4A0gzhJu63AHCTIfcdYWVmfXHSOlMmWtcsqi2SJmUK/N2RvbDiWcUSRx6K6hcuX3kQwfZOqhmbFOjxqgjaUvD7SZ0+6V51loa9iNlZFtE69sp9/Ysirj1RymSlPJUzKbTSDsHq5mpB6Ukt3T9gmh3KDvly2w58rSZphVXdph0JQi5ykUo/KZNPUYcLm4HJggt9ArtuCh14/qbubi7PLK7PGXWlQUrVKn6C6cVJap7ZnmD1QWzDdoMKGP0iXNWZ0hzyCfdM5bpqhUrWsrouldElBk31dX2uJYslUybtdL2zZlnaRXT9YzGSQc3VxoHSuxWx7MzBfsGsvsTTJdaDWs1y7ecVf6LvDrrd+yjR6h8O4o2HEt8xAiECXkamhKFWbJzWswyTHraxrVbAwnDiXD8OLXmGXxNY2Loyncy9kozvFnXCffsu5lqaEqYJdtT+3J4e0wFhGO1q6a3O/jm9hzsSti1+OYESae54zwGd4WUR3wCrIfJRTXkPXQIiHadVFVDzOa7Mfpi54jMN5ujGxSl5/qpLPppeHezosqDle0IM4StLflTJNTcx+iYKgqSnXsLlVh2WhWrxK2L3bR2g0OoZyOaFJxJ29edCoPJ2Af5Fpqpt5MmpfkVE62ltVRzuIzzSeUnaHkVFwWTO+zKg8fEmHyku+OTeRlYygsp6uUUzHYa46RoNJuJtfLiyOtTLKLA==";
function decodeB64ToU8(b64){
  var bin=atob(b64), n=bin.length, out=new Uint8Array(n);
  for(var i=0;i<n;i++) out[i]=bin.charCodeAt(i);
  return out;
}
var BN256_RAW=decodeB64ToU8(BN256_B64);
var BN512_RAW=decodeB64ToU8(BN512_B64);
function normMask(raw){
  var out=new Float32Array(raw.length);
  for(var i=0;i<raw.length;i++) out[i]=raw[i]/255;
  return out;
}
var BN256_NORM=normMask(BN256_RAW);
var BN512_NORM=normMask(BN512_RAW);
function currentDither(){
  var s=document.getElementById("selDither");
  var v=s?s.value:"fs";
  switch(v){
    case "none": return null;
    case "bayer2": return {kind:"ordered", n:2, m:BAYER_NORM[2], label:"bayer-2x2"};
    case "bayer4": return {kind:"ordered", n:4, m:BAYER_NORM[4], label:"bayer-4x4"};
    case "bayer8": return {kind:"ordered", n:8, m:BAYER_NORM[8], label:"bayer-8x8"};
    case "bn256": return {kind:"ordered", n:256, m:BN256_NORM, label:"bluenoise-256"};
    case "bn512": return {kind:"ordered", n:512, m:BN512_NORM, label:"bluenoise-512"};
    case "fs": return {kind:"fs", n:null, m:null, label:"floyd-steinberg"};
    case "hybrid": return {kind:"hybrid", n:null, m:null, bn:BN512_RAW, label:"bluenoise-512-floyd-steinberg-oklch"};
    default: return {kind:"fs", n:null, m:null, label:"floyd-steinberg"};
  }
}
/* Floyd-Steinberg: difusión de error en serpentina. srcFloat es un
   Float32Array sRGB 0..255, 4 canales RGBA, arriba→abajo; se MUTA
   (acumula el error), así que pásale un buffer que no se necesite
   intacto. dest es el Uint8ClampedArray destino (misma disposición).
   Error: 7/16 derecha, 3/16 abajo-izquierda, 5/16 abajo, 1/16
   abajo-derecha. El alfa se copia redondeado, sin difuminar. */
function floydSteinbergQuantize(srcFloat, w, h, dest){
  for(var y=0;y<h;y++){
    var ltr=(y%2===0), dir=ltr?1:-1;
    for(var xi=0;xi<w;xi++){
      var x=ltr?xi:(w-1-xi), base=(y*w+x)*4;
      for(var c=0;c<3;c++){
        var idx=base+c, v=srcFloat[idx];
        var q=Math.round(v);
        if(q<0)q=0; else if(q>255)q=255;
        dest[idx]=q;
        var err=v-q;
        if(err===0) continue;
        var x1=x+dir;
        if(x1>=0&&x1<w) srcFloat[(y*w+x1)*4+c]+=err*0.4375;
        if(y+1<h){
          var x2=x-dir;
          if(x2>=0&&x2<w) srcFloat[((y+1)*w+x2)*4+c]+=err*0.1875;
          srcFloat[((y+1)*w+x)*4+c]+=err*0.3125;
          if(x1>=0&&x1<w) srcFloat[((y+1)*w+x1)*4+c]+=err*0.0625;
        }
      }
    }
  }
  for(var i=3;i<srcFloat.length;i+=4) dest[i]=Math.round(srcFloat[i]);
}
/* Oklab → sRGB float 0..255 (sin redondear ni fijar a byte): la
   versión en float de oklabToSrgb, para medir el error en el híbrido. */
function oklabToSrgbFloat(L,a,b,out){
  var l_=L + 0.3963377774*a + 0.2158037573*b;
  var m_=L - 0.1055613458*a - 0.0638541728*b;
  var s_=L - 0.0894841775*a - 1.2914855480*b;
  var l=l_*l_*l_, m=m_*m_*m_, s=s_*s_*s_;
  out[0]=encode255( 4.0767416621*l - 3.3077115913*m + 0.2309699292*s);
  out[1]=encode255(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s);
  out[2]=encode255(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s);
}
/* Híbrido: blue noise 512 + Floyd-Steinberg en Oklch (sin mesh).
   srcFloat: Float32Array sRGB 0..255, 4 canales, arriba→abajo.
   Se convierte a Oklab (la forma cartesiana de Oklch), se suma el
   blue noise 512 (±1/255) solo al canal L, y la difusión de error se
   hace en Oklab: por píxel se convierte a sRGB, se redondea a byte,
   se vuelve a convertir ese byte a Oklab para medir el error, y el
   error se reparte a los vecinos en Oklab. bnRaw es la máscara
   blue noise 512 (Uint8Array 512×512); se pasa como parámetro para
   que funcione también en los Web Workers. Sin mesh ni capas
   diagonales: esto es un dither de imagen, no un degradado.
   El alfa se copia redondeado. */
function hybridQuantize(srcFloat, w, h, dest, bnRaw){
  var n=w*h, lab=new Float32Array(n*3), tmp=[0,0,0], rgb=[0,0,0], qlab=[0,0,0];
  for(var i=0;i<n;i++){
    var o=i*4;
    srgbToOklab(srcFloat[o], srcFloat[o+1], srcFloat[o+2], tmp);
    var lo=i*3;
    lab[lo]=tmp[0]; lab[lo+1]=tmp[1]; lab[lo+2]=tmp[2];
  }
  /* Blue noise 512 solo en L: (bn/255−0.5)·(2/255) = ±1/255. */
  for(var by=0;by<h;by++){
    var bnrow=(by%512)*512;
    for(var bx=0;bx<w;bx++){
      lab[(by*w+bx)*3]+=(bnRaw[bnrow+(bx%512)]/255-0.5)*(2/255);
    }
  }
  for(var y=0;y<h;y++){
    var ltr=(y%2===0), dir=ltr?1:-1;
    for(var xi=0;xi<w;xi++){
      var x=ltr?xi:(w-1-xi), li=(y*w+x)*3, di=(y*w+x)*4;
      oklabToSrgbFloat(lab[li], lab[li+1], lab[li+2], rgb);
      var qr=Math.round(rgb[0]<0?0:rgb[0]>255?255:rgb[0]);
      var qg=Math.round(rgb[1]<0?0:rgb[1]>255?255:rgb[1]);
      var qb=Math.round(rgb[2]<0?0:rgb[2]>255?255:rgb[2]);
      dest[di]=qr; dest[di+1]=qg; dest[di+2]=qb;
      srgbToOklab(qr,qg,qb,qlab);
      var eL=lab[li]-qlab[0], ea=lab[li+1]-qlab[1], eb=lab[li+2]-qlab[2];
      if(eL===0&&ea===0&&eb===0) continue;
      var x1=x+dir;
      if(x1>=0&&x1<w){
        var n1=(y*w+x1)*3;
        lab[n1]+=eL*0.4375; lab[n1+1]+=ea*0.4375; lab[n1+2]+=eb*0.4375;
      }
      if(y+1<h){
        var x2=x-dir;
        if(x2>=0&&x2<w){
          var n2=((y+1)*w+x2)*3;
          lab[n2]+=eL*0.1875; lab[n2+1]+=ea*0.1875; lab[n2+2]+=eb*0.1875;
        }
        var n3=((y+1)*w+x)*3;
        lab[n3]+=eL*0.3125; lab[n3+1]+=ea*0.3125; lab[n3+2]+=eb*0.3125;
        if(x1>=0&&x1<w){
          var n4=((y+1)*w+x1)*3;
          lab[n4]+=eL*0.0625; lab[n4+1]+=ea*0.0625; lab[n4+2]+=eb*0.0625;
        }
      }
    }
  }
  for(var a=3;a<srcFloat.length;a+=4) dest[a]=Math.round(srcFloat[a]);
}


/* Al cambiar el dithering (combobox), la rejilla y el antes/después
   se re-renderizan con el nuevo ajuste para verlo aplicado en tiempo
   real. Durante la fase de genes los controles están ocultos y no se
   toca nada. */
function refreshDitherPreviews(){
  if(!source || rendering) return;
  if(typeof genePhase!=="undefined" && genePhase) return;
  renderPopulation();
}
var selDitherEl=document.getElementById("selDither");
if(selDitherEl) selDitherEl.addEventListener("change", refreshDitherPreviews);
/* ---------- HDR content: JPEG Ultra HDR (gain map, ISO 21496-1) ----------
   Por qué ya no es un PNG PQ: el usuario abre la descarga en el visor
   de imágenes de Windows y como fondo de pantalla, y ninguno de los
   dos interpreta el chunk cICP del PNG HDR. Ahí el PQ se decodifica
   como si fuera gamma sRGB: las sombras se levantan muchísimo y todo
   se ve pastel y lavado, sin importar el pico (300 o 1000 nits) ni
   las primarias que se escriban. Un PNG PQ sin respaldo SDR nunca se
   va a ver bien en ese monitor.
   El formato con respaldo es JPEG Ultra HDR:
   - La imagen base es un JPEG SDR normal: exactamente la misma
     renderización que la vista previa web (misma cadena, mismo
     dithering si está activo). En cualquier visor SDR (Windows,
     fondo de pantalla, navegadores sin HDR) se ve idéntica a la
     preview, que es lo que el usuario pidió.
   - El gain map (segunda imagen JPEG, localizada vía MPF APP2, con
     metadatos XMP hdrgm) guarda por píxel cuánto multiplicar la luz
     lineal de la base para llegar a la versión HDR. En pantallas y
     visores compatibles (Chrome, Android, visores Ultra HDR) la
     imagen se reconstruye con ese rango extra: HDR real.
   Matemática del gain map, desde luz lineal (srgbLin255), nunca
   desde valores con gamma: la base SDR es la rendición de referencia
   (su blanco difuso equivale a ~100 nits nominales) y el boost solo
   crece con la luminancia lineal (factor 1 + (boost−1)·Y³): las
   sombras quedan como la preview y las luces suben hasta
   boost×100 nits de pico (1000 nits con boost 10, 400 con boost 4).
   Ganancia por canal g = (lin·f + ε)/(lin + ε), ε = 1/64 (offset de
   la especificación), guardada como log2(g)/log2(boost) en 8 bits. */
var hdrPreviewImgEl=document.getElementById("hdrPreviewImg"),
    hdrBadgeEl=document.getElementById("hdrBadge");
var selHdrTargetEl=document.getElementById("selHdrTarget");
function currentHdr(){ return !!(selHdrTargetEl && selHdrTargetEl.value!=="0"); }
function hdrBoost(){ var v=selHdrTargetEl?selHdrTargetEl.value:"0"; return v==="4"?4:10; }
function hdrFileSuffix(){ return "-ultrahdr"; }
/* La original a resolución completa, en float y sin cuantizar */
function renderFullFloat(genome){
  var c=document.createElement("canvas"); c.width=sW; c.height=sH;
  var ctx=c.getContext("2d");
  ctx.drawImage(source, 0, 0, sW, sH);
  var data=ctx.getImageData(0, 0, sW, sH);
  return { fd:processGenomeFd(data, genome||identityGenome()), w:sW, h:sH };
}
/* Vista previa: la base SDR del Ultra HDR ES el canvas que ya se
   muestra, así que no hay nada que superponer; solo la insignia cambia.
   Las miniaturas igual: ya muestran la base SDR. */
function hideHdrPreview(){
  if(hdrPreviewImgEl){ hdrPreviewImgEl.hidden=true; hdrPreviewImgEl.removeAttribute("src"); }
  if(hdrBadgeEl) hdrBadgeEl.hidden=true;
}
function scheduleHdrPreview(){
  if(!currentHdr() || !source) return;
  if(hdrPreviewImgEl) hdrPreviewImgEl.hidden=true;
  if(hdrBadgeEl){ hdrBadgeEl.textContent="Ultra HDR"; hdrBadgeEl.hidden=false; }
}
function refreshHdrThumbs(){ /* las miniaturas ya son la base SDR */ }
function invalidateHdrThumbs(){}
function clearHdrThumbs(){}
if(selHdrTargetEl) selHdrTargetEl.addEventListener("change", function(){
  if(currentHdr()) scheduleHdrPreview();
  else hideHdrPreview();
});
/* Gain map a media resolución (lo habitual en Ultra HDR): se muestrea
   la cadena float32 completa y se calcula la ganancia por canal. */
function buildGainMapCanvas(fd, w, h, boost){
  var gw=Math.max(1, Math.ceil(w/2)), gh=Math.max(1, Math.ceil(h/2));
  var c=document.createElement("canvas"); c.width=gw; c.height=gh;
  var ctx=c.getContext("2d");
  var img=ctx.createImageData(gw, gh), d=img.data;
  var OFF=0.015625, maxLog=Math.log(boost)/Math.LN2;
  for(var y=0;y<gh;y++){
    var sy=Math.min(h-1, y*2);
    for(var x=0;x<gw;x++){
      var pp=(sy*w + Math.min(w-1, x*2))*4;
      var lr=fd[pp], lg=fd[pp+1], lb=fd[pp+2];
      lr=lr<0?0 : lr>255?255 : lr; lg=lg<0?0 : lg>255?255 : lg; lb=lb<0?0 : lb>255?255 : lb;
      var linR=srgbLin255(lr), linG=srgbLin255(lg), linB=srgbLin255(lb);
      var Y=0.2126*linR+0.7152*linG+0.0722*linB; if(Y>1) Y=1; if(Y<0) Y=0;
      var f=1+(boost-1)*Y*Y*Y;
      var o=(y*gw+x)*4, lin=[linR, linG, linB];
      for(var ci=0;ci<3;ci++){
        var g=(lin[ci]*f+OFF)/(lin[ci]+OFF);
        var lg2=g>1 ? Math.log(g)/Math.LN2 : 0;
        var b=Math.round(255*(lg2/maxLog));
        d[o+ci]= b<0?0 : b>255?255 : b;
      }
      d[o+3]=255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function buildXmpSegment(boost){
  var maxLog=Math.log(boost)/Math.LN2;
  function n6(v){ return v.toFixed(6); }
  var xmp='<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Genetic Color Grading">'
    + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"'
    + ' hdrgm:Version="1.0" hdrgm:BaseRenditionIsHDR="False" hdrgm:Gamma="1.000000"'
    + ' hdrgm:HDRCapacityMin="0.000000" hdrgm:HDRCapacityMax="'+n6(maxLog)+'"'
    + ' hdrgm:GainMapMin="'+n6(0)+'" hdrgm:GainMapMax="'+n6(maxLog)+'"'
    + ' hdrgm:OffsetSDR="'+n6(0.015625)+'" hdrgm:OffsetHDR="'+n6(0.015625)+'">'
    + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  var id=strBytes("http://ns.adobe.com/xap/1.0/\0");
  var xb=strBytes(xmp);
  var len=2+id.length+xb.length;
  var seg=new Uint8Array(2+len);
  seg[0]=0xFF; seg[1]=0xE1; seg[2]=(len>>8)&0xFF; seg[3]=len&0xFF;
  seg.set(id, 4); seg.set(xb, 4+id.length);
  return seg;
}
/* Segmento MPF (APP2): firma "MPF\0" (4 bytes, la que buscan los
   lectores de libultrahdr/hdrify/HDRView; la firma larga anterior
   del spec CIPA era descartada), encabezado TIFF little-endian
   ("II", como libultrahdr) con los tags 0xB000 (MPFVersion "0100"),
   0xB001 (NumberOfImages = 2) y 0xB002 (MPImageList, los 32 bytes
   de MPEntry, offset 50 relativo al TIFF). Image Type: 0x00030000
   para la primaria (Baseline MP Primary Image) y 0x00000000 para
   el gain map (así lo escribe libultrahdr). Los offsets de MPEntry
   son absolutos desde el inicio del archivo: la primaria en 0 con
   su tamaño total, y el gain map exactamente donde se escribe su
   SOI (FFD8) en el archivo final. */
function buildMpfSegment(primaryLen, gainLen, gainOffset){
  var dataLen=4+82;
  var seg=new Uint8Array(2+2+dataLen), dv=new DataView(seg.buffer);
  seg[0]=0xFF; seg[1]=0xE2;
  var len=dataLen+2; seg[2]=(len>>8)&0xFF; seg[3]=len&0xFF;
  seg.set(strBytes("MPF\0"), 4);
  var o=8; /* inicio del encabezado TIFF, tras marcador+longitud+firma */
  seg[o]=0x49; seg[o+1]=0x49; dv.setUint16(o+2, 42, true); dv.setUint32(o+4, 8, true);
  var ifd=o+8;
  dv.setUint16(ifd, 3, true);
  var e=ifd+2;
  dv.setUint16(e, 0xB000, true); dv.setUint16(e+2, 7, true); dv.setUint32(e+4, 4, true);
  seg[e+8]=0x30; seg[e+9]=0x31; seg[e+10]=0x30; seg[e+11]=0x30; /* "0100" */
  e+=12;
  dv.setUint16(e, 0xB001, true); dv.setUint16(e+2, 4, true); dv.setUint32(e+4, 1, true); dv.setUint32(e+8, 2, true);
  e+=12;
  dv.setUint16(e, 0xB002, true); dv.setUint16(e+2, 7, true); dv.setUint32(e+4, 32, true); dv.setUint32(e+8, 50, true);
  e+=12;
  dv.setUint32(e, 0, true); /* sin IFD siguiente */
  var mp=o+50;
  dv.setUint32(mp, 0x00030000, true); dv.setUint32(mp+4, primaryLen, true); dv.setUint32(mp+8, 0, true);
  dv.setUint32(mp+16, 0x00000000, true); dv.setUint32(mp+20, gainLen, true); dv.setUint32(mp+24, gainOffset, true);
  return seg;
}
function assembleUltraHdr(baseBytes, gainBytes, json, boost){
  var withMeta=embedJpegMeta(baseBytes, json);
  var xmp=buildXmpSegment(boost);
  var mpfLen=2+2+4+82;
  var primaryLen=withMeta.length + xmp.length + mpfLen;
  /* libultrahdr exige el offset del gain map RELATIVO al encabezado
     TIFF del MPF (tiff = mpfPos + 8), no absoluto: secondary_offset =
     primaryLen - mpfPos - 8, para que tiff + offset == primaryLen. */
  var mpfPos = 2 + xmp.length;
  var mpf=buildMpfSegment(primaryLen, gainBytes.length, primaryLen - mpfPos - 8);
  var primary=new Uint8Array(primaryLen);
  primary.set(withMeta.subarray(0, 2), 0);
  primary.set(xmp, 2);
  primary.set(mpf, 2+xmp.length);
  primary.set(withMeta.subarray(2), 2+xmp.length+mpf.length);
  var out=new Uint8Array(primaryLen+gainBytes.length);
  out.set(primary, 0);
  out.set(gainBytes, primaryLen);
  return out;
}
function buildUltraHdrBlob(g, info, dith, cb){
  try{
    var baseCanvas=renderFull(info.cellIdx===CENTER_CELL?null:g, dith);
    baseCanvas.toBlob(function(baseBlob){
      if(!baseBlob){ cb(null); return; }
      var rf;
      try{ rf=renderFullFloat(info.cellIdx===CENTER_CELL?null:g); }
      catch(e){ cb(null); return; }
      var gmCanvas=buildGainMapCanvas(rf.fd, rf.w, rf.h, hdrBoost());
      gmCanvas.toBlob(function(gmBlob){
        if(!gmBlob){ cb(null); return; }
        Promise.all([baseBlob.arrayBuffer(), gmBlob.arrayBuffer()]).then(function(bufs){
          try{
            var out=assembleUltraHdr(new Uint8Array(bufs[0]), new Uint8Array(bufs[1]), genomeJSON(g), hdrBoost());
            cb(new Blob([out], {type:"image/jpeg"}));
          }catch(e){ cb(null); }
        }).catch(function(){ cb(null); });
      }, "image/jpeg", 0.92);
    }, "image/jpeg", 0.95);
  }catch(e){ cb(null); }
}
/* ---------- Exportar la variante del detalle, a resolución completa ---------- */
function renderFull(genome, dith){
  var out=document.createElement("canvas"); out.width=sW; out.height=sH;
  var ctx=out.getContext("2d");
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high";
  if(dith){
    /* Con dithering pedido, la exportación va SIEMPRE por la cadena
       CPU float32 (processGenome), sin pasar por la GPU: es la única
       ruta cuyo Bayer se aplica garantizado en la única cuantización
       float32 → 8 bits, en cualquier navegador. La ruta GPU con
       readPixels en float dependía de EXT_color_buffer_float y del
       driver, y en el navegador del usuario la descarga salía sin
       difuminar (idéntica a la de sin dithering) aunque esta rama se
       ejecutaba; por eso ya no se intenta. También cubre el original
       (genome null): pasa por la misma cuantización con dither. */
    ctx.drawImage(source,0,0,sW,sH);
    var ddata=ctx.getImageData(0,0,sW,sH);
    processGenome(ddata, genome||identityGenome(), dith);
    ctx.putImageData(ddata,0,0);
    return out;
  }
  if(genome && GPU.render(source, sW, sH, genome, ctx)) return out;
  ctx.drawImage(source,0,0,sW,sH);
  if(genome){
    var data=ctx.getImageData(0,0,sW,sH);
    processGenome(data, genome, null);
    ctx.putImageData(data,0,0);
  }
  return out;
}
var dlBtns=[
  document.getElementById("btnDownloadBoth")
];
function setDownloadsDisabled(dis){
  dlBtns.forEach(function(b){ if(b) b.disabled=dis; });
}
function triggerDownload(blob, filename){
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(a.href); },4000);
}
function variantFileInfo(){
  var cellIdx=previewCell;
  var base=sName.replace(/\.[^.]+$/,"").replace(/[^\w\- ]+/g,"").trim()||"imagen";
  var label= cellIdx===CENTER_CELL ? "original" : "gen"+generation+"-var"+((cellIdx<CENTER_CELL?cellIdx:cellIdx-1)+1);
  return { cellIdx:cellIdx, base:base, label:label };
}
/* Imagen a resolución completa, con el genoma incrustado como hasta ahora.
   El estado de dithering (checkbox + barra) se lee en el clic y llega
   hasta aquí ya resuelto: no se relee el DOM dentro del setTimeout. */
function buildFullImageBlob(g, info, dith, hdr, cb){
  var json=genomeJSON(g);
  if(hdr){
    /* HDR: JPEG Ultra HDR con gain map. La base es la renderización
       SDR de siempre (idéntica a la preview, con el dithering si está
       activo) y el gain map lleva el rango HDR extra; el genoma va
       incrustado en un segmento COM, como en el JPEG normal. */
    buildUltraHdrBlob(g, info, dith, cb);
    return;
  }
  try{
    var out=renderFull(info.cellIdx===CENTER_CELL?null:g, dith);
    out.toBlob(function(blob){
      if(!blob){ cb(null); return; }
      blob.arrayBuffer().then(function(buf){
        cb(new Blob([embedPngMeta(buf,json)],{type:"image/png"}));
      }).catch(function(){ cb(null); });
    },"image/png");
  }catch(err){ cb(null); }
}
function exportImage(){
  var g=genomeAtCell(previewCell);
  if(!g||!source||rendering) return;
  var info=variantFileInfo();
  var dith=currentDither(); /* método del combobox, leído en el clic */
  var hdr=currentHdr();
  setDownloadsDisabled(true);
  showToast("Procesando imagen…");
  setTimeout(function(){
    buildFullImageBlob(g, info, dith, hdr, function(finalBlob){
      setDownloadsDisabled(false);
      if(!finalBlob){ showToast("Falló la descarga de la imagen."); return; }
      triggerDownload(finalBlob, info.base+"-"+info.label+(hdr?hdrFileSuffix():"")+(dith?"-dithering-"+dith.label:"")+(hdr?".jpg":".png"));
      showToast("Imagen descargada.");
    });
  },30);
}
/* Pasos espaciales activos en un genoma: usan el vecindario del píxel
   y NO se pueden hornear en un .cube (una LUT 3D es puntual). La imagen
   exportada sí los lleva; la LUT horneada, no. */
var SPATIAL_GENE_LABELS={dehaze:"Dehaze", retinex:"Retinex", clarity:"Clarity", loclap:"Laplaciano local", guided:"Guided Detail"};
function spatialGenesActive(g){
  var names=[];
  if(!g || !g.values) return names;
  Object.keys(SPATIAL_GENE_LABELS).forEach(function(k){
    var v=g.values[k];
    if(v!==undefined && v!==0) names.push(SPATIAL_GENE_LABELS[k]);
  });
  return names;
}
function exportBaked(){
  var g=genomeAtCell(previewCell);
  if(!g||!source||rendering) return;
  var info=variantFileInfo();
  setDownloadsDisabled(true);
  showToast("Horneando LUT 65³…");
  progressEl.style.display="block"; progressBar.style.width="0%";
  ensure65ForGenome(g, function(){
    buildBakedLutAsync(g, function(f){ progressBar.style.width=Math.round(f*100)+"%"; }, function(data){
      try{
        var blob=bakedLutBlob(g, info.base+" "+info.label+" - LUT horneada", data);
        progressEl.style.display="none";
        setDownloadsDisabled(false);
        triggerDownload(blob, info.base+"-"+info.label+"-lut-horneada.cube");
        var spB=spatialGenesActive(g);
        showToast(spB.length ? "LUT descargada, pero sin "+spB.join(", ")+": son espaciales y no caben en un .cube." : "LUT horneada descargada (.cube 65³).");
      }catch(err){ progressEl.style.display="none"; setDownloadsDisabled(false); showToast("Falló la LUT horneada."); }
    });
  });
}
function exportBoth(){
  var g=genomeAtCell(previewCell);
  if(!g||!source||rendering) return;
  var info=variantFileInfo();
  var dith=currentDither(); /* método del combobox, leído en el clic */
  var hdr=currentHdr();
  setDownloadsDisabled(true);
  showToast("Procesando imagen y LUT 65³…");
  progressEl.style.display="block"; progressBar.style.width="0%";
  /* La LUT descargada es 65³: primero se generan las rejillas 65³ de
     la cadena (bajo demanda) y el horneado va troceado con progreso,
     para no bloquear con un trabajo 7.6× el del antiguo 33³. */
  ensure65ForGenome(g, function(){
    buildBakedLutAsync(g, function(f){ progressBar.style.width=Math.round(f*100)+"%"; }, function(data){
      var lutBlob=null;
      try{ lutBlob=bakedLutBlob(g, info.base+" "+info.label+" - LUT horneada", data); }catch(err){}
      progressEl.style.display="none";
      buildFullImageBlob(g, info, dith, hdr, function(imgBlob){
        setDownloadsDisabled(false);
        if(!imgBlob && !lutBlob){ showToast("Falló la descarga."); return; }
        if(imgBlob) triggerDownload(imgBlob, info.base+"-"+info.label+(hdr?hdrFileSuffix():"")+(dith?"-dithering-"+dith.label:"")+(hdr?".jpg":".png"));
        if(lutBlob){
          /* Segunda descarga con un respiro: algunos navegadores bloquean
             dos descargas simultáneas desde el mismo gesto. */
          setTimeout(function(){ triggerDownload(lutBlob, info.base+"-"+info.label+"-lut-horneada.cube"); },450);
        }
        showToast(imgBlob&&lutBlob ? (spatialGenesActive(g).length ? "Descargado. Ojo: la LUT no lleva "+spatialGenesActive(g).join(", ")+" (espaciales); la imagen sí." : "Descargado.") : "Descarga parcial.");
      });
    });
  });
}
dlBtns[0].addEventListener("click", exportBoth);

/* ---------- Mostrar / ocultar la lista de transformaciones ---------- */
var chkTransforms=document.getElementById("chkTransforms"),
    transformPanel=document.getElementById("transformPanel"),
    stageLayout=document.querySelector(".stage-layout");
chkTransforms.addEventListener("change", function(){
  transformPanel.hidden=!chkTransforms.checked;
  stageLayout.classList.toggle("show-transforms", chkTransforms.checked);
  if(chkTransforms.checked) showDetail(previewCell);
  syncTransformHeight();
  requestAnimationFrame(function(){
    refreshPreviewResolution(); syncTransformHeight();
    /* Al marcar Transformaciones, llevar el foco (y la vista) al panel
       con scroll de transformaciones que se acaba de mostrar. */
    if(chkTransforms.checked && !transformPanel.hidden){
      var reduceMotion=window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      transformPanel.scrollIntoView({behavior:reduceMotion?"auto":"smooth", block:"nearest"});
      try{ transformPanel.focus({preventScroll:true}); }catch(e){ transformPanel.focus(); }
    }
  });
});
/* Transformaciones: sin tope del 60%; el panel se estira hasta el fondo
   de la vista con 20px de margen inferior (ver CSS: columna sticky a
   altura de viewport en escritorio, tope 100dvh−40px en el resto). */
var previewZoneEl=document.getElementById("previewZone"),
    previewColEl=document.querySelector(".preview-col");
function syncTransformHeight(){
  if(!previewZoneEl||!transformPanel) return;
  transformPanel.style.maxHeight="";
  var h=previewZoneEl.offsetHeight;
  if(h && previewColEl) previewColEl.style.setProperty("--preview-h", h+"px");
}
if(window.ResizeObserver&&previewZoneEl){
  var transformRO=new ResizeObserver(function(){ syncTransformHeight(); });
  transformRO.observe(previewZoneEl);
}
window.addEventListener("resize", syncTransformHeight);
syncTransformHeight();
requestAnimationFrame(syncTransformHeight);

/* ---------- Scopes / datos técnicos (estilo DaVinci) ----------
   Se calculan desde la imagen ya graduada que muestra la vista previa
   (previewCanvas), nunca desde la original salvo que la celda previa
   sea la central. Se muestrea a 256px máximo para no bloquear la UI
   y solo se recalcula, con debounce, si el panel está visible. */
var chkScopes=document.getElementById("chkScopes"),
    scopePanel=document.getElementById("scopePanel"),
    scopeTarget=document.getElementById("scopeTarget"),
    scopeEmpty=document.getElementById("scopeEmpty"),
    scopeContent=document.getElementById("scopeContent");
var scopeSample=document.createElement("canvas");
var diffSample=document.createElement("canvas");
var diffGradSample=document.createElement("canvas");
var falseSample=document.createElement("canvas");
var scopeTimer=null;
function scheduleScopesUpdate(){
  if(!chkScopes || !chkScopes.checked || !scopePanel || scopePanel.hidden) return;
  if(scopeTimer) return;
  scopeTimer=setTimeout(function(){ scopeTimer=null; updateScopes(); }, 140);
}
function hueNameEs(deg){
  if(deg<15||deg>=345) return "Rojo";
  if(deg<45) return "Naranja";
  if(deg<70) return "Amarillo";
  if(deg<95) return "Amarillo-verde";
  if(deg<165) return "Verde";
  if(deg<195) return "Cian";
  if(deg<255) return "Azul";
  if(deg<285) return "Violeta";
  return "Magenta";
}
function scopeGridLines(ctx,W,H,thirds){
  ctx.strokeStyle="rgba(255,255,255,.14)"; ctx.lineWidth=1; ctx.beginPath();
  [0.25,0.5,0.75].forEach(function(f){ var y=Math.round(H*f)+0.5; ctx.moveTo(0,y); ctx.lineTo(W,y); });
  ctx.stroke();
  if(thirds){
    ctx.strokeStyle="rgba(255,255,255,.22)"; ctx.beginPath();
    [1/3,2/3].forEach(function(f){ var x=Math.round(W*f)+0.5; ctx.moveTo(x,0); ctx.lineTo(x,H); });
    ctx.stroke();
    ctx.fillStyle="rgba(255,255,255,.55)"; ctx.font="9px 'IBM Plex Mono',monospace";
    ctx.fillText("R",4,H-4); ctx.fillText("G",Math.round(W/3)+4,H-4); ctx.fillText("B",Math.round(2*W/3)+4,H-4);
  }
  ctx.fillStyle="rgba(255,255,255,.55)"; ctx.font="9px 'IBM Plex Mono',monospace";
  ctx.fillText("100",W-22,10); ctx.fillText("0",W-10,H-4);
}
function updateScopes(){
  if(!scopePanel || scopePanel.hidden) return;
  if(!source || !previewCanvas || !previewCanvas.width || !previewCanvas.height){
    scopeTarget.textContent="Sin imagen";
    scopeEmpty.hidden=false; scopeContent.hidden=true;
    return;
  }
  var pw=previewCanvas.width, ph=previewCanvas.height;
  var sc=Math.min(256/pw, 256/ph, 1);
  var sw=Math.max(8, Math.round(pw*sc)), sh=Math.max(8, Math.round(ph*sc));
  scopeSample.width=sw; scopeSample.height=sh;
  var sctx=scopeSample.getContext("2d");
  sctx.imageSmoothingEnabled=true; sctx.imageSmoothingQuality="high";
  try{ sctx.drawImage(previewCanvas,0,0,sw,sh); }catch(e){ return; }
  var imgData;
  try{ imgData=sctx.getImageData(0,0,sw,sh); }catch(e){ return; }
  var d=imgData.data, total=sw*sh;
  if(!total) return;
  var histR=new Uint32Array(256), histG=new Uint32Array(256), histB=new Uint32Array(256), histL=new Uint32Array(256);
  var hueHist=new Uint32Array(36);
  var sumR=0,sumG=0,sumB=0,sumL=0,sumSat=0, clipS=0, clipH=0;
  /* Datos para los scopes, guardados para dibujarlos tras el conteo */
  var lumas=new Uint8Array(total), rs=new Uint8Array(total), gs=new Uint8Array(total), bs=new Uint8Array(total);
  for(var i=0,p=0;i<d.length;i+=4,p++){
    var r=d[i], g=d[i+1], b=d[i+2];
    rs[p]=r; gs[p]=g; bs[p]=b;
    var luma=Math.round(0.2126*r + 0.7152*g + 0.0722*b);
    lumas[p]=luma;
    histR[r]++; histG[g]++; histB[b]++; histL[luma]++;
    sumR+=r; sumG+=g; sumB+=b; sumL+=luma;
    if(luma<=2) clipS++;
    if(luma>=253) clipH++;
    var mx=Math.max(r,g,b), mn=Math.min(r,g,b), dl=mx-mn;
    sumSat+= mx>0 ? dl/mx : 0;
    if(dl>12 && mx>18){
      var hue;
      if(mx===r) hue=60*(((g-b)/dl)%6); else if(mx===g) hue=60*((b-r)/dl+2); else hue=60*((r-g)/dl+4);
      if(hue<0) hue+=360;
      hueHist[Math.min(35, Math.floor(hue/10))]++;
    }
  }
  var meanR=sumR/total, meanG=sumG/total, meanB=sumB/total, meanL=sumL/total;
  function pctFromHist(hist, pct){
    var target=total*pct/100, acc=0;
    for(var v=0;v<256;v++){ acc+=hist[v]; if(acc>=target) return v; }
    return 255;
  }
  var p5=pctFromHist(histL,5), p95=pctFromHist(histL,95);
  var domBin=0; for(var hb=1;hb<36;hb++) if(hueHist[hb]>hueHist[domBin]) domBin=hb;
  var domDeg=domBin*10+5, hasHue=hueHist[domBin]>0;
  /* --- Waveform luma --- */
  (function(){
    var cv=document.getElementById("scopeWave"); if(!cv) return;
    var W=cv.width, H=cv.height, ctx=cv.getContext("2d");
    var counts=new Uint16Array(W*H);
    for(var p2=0;p2<total;p2++){
      var x=Math.min(W-1, Math.floor((p2%sw)/sw*W));
      var y=H-1-Math.min(H-1, Math.floor(lumas[p2]/255*H));
      counts[y*W+x]++;
    }
    var out=ctx.createImageData(W,H), od=out.data;
    for(var q=0;q<W*H;q++){
      var idx=q*4, c=counts[q];
      od[idx]=13; od[idx+1]=12; od[idx+2]=11; od[idx+3]=255;
      if(c){ var inten=Math.min(255, 40+c*42); od[idx]=Math.round(inten*0.45); od[idx+1]=inten; od[idx+2]=Math.round(inten*0.62); }
    }
    ctx.putImageData(out,0,0); scopeGridLines(ctx,W,H,false);
  })();
  /* --- Parade RGB --- */
  (function(){
    var cv=document.getElementById("scopeParade"); if(!cv) return;
    var W=cv.width, H=cv.height, ctx=cv.getContext("2d");
    var sec=Math.floor(W/3);
    var cR=new Uint16Array(W*H), cG=new Uint16Array(W*H), cB=new Uint16Array(W*H);
    for(var p2=0;p2<total;p2++){
      var lx=Math.floor((p2%sw)/sw*sec);
      var yR=H-1-Math.min(H-1, Math.floor(rs[p2]/255*H)); cR[yR*W+lx]++;
      var yG=H-1-Math.min(H-1, Math.floor(gs[p2]/255*H)); cG[yG*W+sec+lx]++;
      var yB=H-1-Math.min(H-1, Math.floor(bs[p2]/255*H)); cB[yB*W+2*sec+lx]++;
    }
    var out=ctx.createImageData(W,H), od=out.data;
    for(var q=0;q<W*H;q++){
      var idx=q*4;
      od[idx]=13; od[idx+1]=12; od[idx+2]=11; od[idx+3]=255;
      if(cR[q]) od[idx]=Math.min(255, 40+cR[q]*42);
      if(cG[q]) od[idx+1]=Math.min(255, 40+cG[q]*42);
      if(cB[q]) od[idx+2]=Math.min(255, 40+cB[q]*42);
    }
    ctx.putImageData(out,0,0); scopeGridLines(ctx,W,H,true);
  })();
  /* --- Vectorscopio --- */
  (function(){
    var cv=document.getElementById("scopeVector"); if(!cv) return;
    var W=cv.width, H=cv.height, ctx=cv.getContext("2d");
    var out=ctx.createImageData(W,H), od=out.data;
    for(var q=0;q<W*H;q++){ var idx0=q*4; od[idx0]=13; od[idx0+1]=12; od[idx0+2]=11; od[idx0+3]=255; }
    var cx=W/2, cy=H/2, scale=(W/2-8)/170;
    for(var p2=0;p2<total;p2++){
      var r=rs[p2], g=gs[p2], b=bs[p2];
      var Y=0.2126*r + 0.7152*g + 0.0722*b;
      var vx=Math.round(cx + (b-Y)*0.564*scale), vy=Math.round(cy - (r-Y)*0.713*scale);
      if(vx<0||vx>=W||vy<0||vy>=H) continue;
      var idx=(vy*W+vx)*4;
      od[idx]=r; od[idx+1]=g; od[idx+2]=b;
    }
    ctx.putImageData(out,0,0);
    ctx.strokeStyle="rgba(255,255,255,.20)"; ctx.lineWidth=1;
    [0.33,0.66,0.98].forEach(function(f){ ctx.beginPath(); ctx.arc(cx,cy,(W/2-6)*f,0,Math.PI*2); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(cx,4); ctx.lineTo(cx,H-4); ctx.moveTo(4,cy); ctx.lineTo(W-4,cy); ctx.stroke();
    var targets=[["R",255,0,0],["M",255,0,255],["B",0,0,255],["C",0,255,255],["G",0,255,0],["Y",255,255,0]];
    ctx.font="10px 'IBM Plex Mono',monospace"; ctx.fillStyle="rgba(255,255,255,.75)";
    targets.forEach(function(t){
      var Y2=0.2126*t[1] + 0.7152*t[2] + 0.0722*t[3];
      var tx=cx + (t[3]-Y2)*0.564*scale*0.75, ty=cy - (t[1]-Y2)*0.713*scale*0.75;
      ctx.strokeStyle="rgba(255,255,255,.45)"; ctx.strokeRect(tx-4,ty-4,8,8);
      ctx.fillText(t[0], tx-3, ty-7);
    });
  })();
  /* --- Histograma RGB --- */
  (function(){
    var cv=document.getElementById("scopeHist"); if(!cv) return;
    var W=cv.width, H=cv.height, ctx=cv.getContext("2d");
    ctx.fillStyle="#0d0c0b"; ctx.fillRect(0,0,W,H);
    var maxC=1, v;
    for(v=0;v<256;v++){ if(histR[v]>maxC)maxC=histR[v]; if(histG[v]>maxC)maxC=histG[v]; if(histB[v]>maxC)maxC=histB[v]; }
    ctx.globalCompositeOperation="lighter";
    var chans=[[histR,"rgba(255,70,60,.62)"],[histG,"rgba(70,220,110,.62)"],[histB,"rgba(80,130,255,.62)"]];
    chans.forEach(function(ch){
      ctx.fillStyle=ch[1]; ctx.beginPath(); ctx.moveTo(0,H);
      for(v=0;v<256;v++){
        var x=v/255*W, hh=Math.sqrt(ch[0][v]/maxC)*(H-8);
        ctx.lineTo(x, H-hh);
      }
      ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
    });
    ctx.globalCompositeOperation="source-over";
    scopeGridLines(ctx,W,H,false);
  })();
  /* --- Histograma de tono --- */
  (function(){
    var cv=document.getElementById("scopeHue"); if(!cv) return;
    var W=cv.width, H=cv.height, ctx=cv.getContext("2d");
    ctx.fillStyle="#0d0c0b"; ctx.fillRect(0,0,W,H);
    var maxC=1; for(var v2=0;v2<36;v2++) if(hueHist[v2]>maxC) maxC=hueHist[v2];
    var bw=W/36;
    for(var b2=0;b2<36;b2++){
      var hh=Math.sqrt(hueHist[b2]/maxC)*(H-14);
      ctx.fillStyle="hsl("+(b2*10+5)+",85%,55%)";
      ctx.fillRect(Math.floor(b2*bw)+1, H-hh, Math.max(1,Math.floor(bw)-2), hh);
    }
    ctx.fillStyle="rgba(255,255,255,.55)"; ctx.font="9px 'IBM Plex Mono',monospace";
    ctx.fillText("0°",4,H-3); ctx.fillText("180°",Math.round(W/2)-10,H-3); ctx.fillText("360°",W-28,H-3);
  })();
  /* --- Cubo 3D de la LUT horneada (bajo el histograma de tono) --- */
  updateCubeData();
  /* --- Waveform RGB (canales superpuestos) --- */
  (function(){
    var cv=document.getElementById("scopeWaveRGB"); if(!cv) return;
    var W=cv.width, H=cv.height, ctx=cv.getContext("2d");
    var cR=new Uint16Array(W*H), cG=new Uint16Array(W*H), cB=new Uint16Array(W*H);
    for(var p2=0;p2<total;p2++){
      var x=Math.min(W-1, Math.floor((p2%sw)/sw*W));
      var yR=H-1-Math.min(H-1, Math.floor(rs[p2]/255*H)); cR[yR*W+x]++;
      var yG=H-1-Math.min(H-1, Math.floor(gs[p2]/255*H)); cG[yG*W+x]++;
      var yB=H-1-Math.min(H-1, Math.floor(bs[p2]/255*H)); cB[yB*W+x]++;
    }
    var out=ctx.createImageData(W,H), od=out.data;
    for(var q=0;q<W*H;q++){
      var idx=q*4;
      od[idx]=13; od[idx+1]=12; od[idx+2]=11; od[idx+3]=255;
      if(cR[q]) od[idx]=Math.min(255, 40+cR[q]*42);
      if(cG[q]) od[idx+1]=Math.min(255, 40+cG[q]*42);
      if(cB[q]) od[idx+2]=Math.min(255, 40+cB[q]*42);
    }
    ctx.putImageData(out,0,0); scopeGridLines(ctx,W,H,false);
  })();
  /* --- Parade YCbCr --- */
  (function(){
    var cv=document.getElementById("scopeParadeYCbCr"); if(!cv) return;
    var W=cv.width, H=cv.height, ctx=cv.getContext("2d");
    var sec=Math.floor(W/3);
    var cY=new Uint16Array(W*H), cCb=new Uint16Array(W*H), cCr=new Uint16Array(W*H);
    for(var p2=0;p2<total;p2++){
      var lx=Math.floor((p2%sw)/sw*sec);
      var r=rs[p2], g=gs[p2], b=bs[p2];
      var Y=0.2126*r + 0.7152*g + 0.0722*b;
      var cb=128 + (b-Y)*0.564; if(cb<0)cb=0; if(cb>255)cb=255;
      var cr=128 + (r-Y)*0.713; if(cr<0)cr=0; if(cr>255)cr=255;
      var yY=H-1-Math.min(H-1, Math.floor(Y/255*H)); cY[yY*W+lx]++;
      var yCb=H-1-Math.min(H-1, Math.floor(cb/255*H)); cCb[yCb*W+sec+lx]++;
      var yCr=H-1-Math.min(H-1, Math.floor(cr/255*H)); cCr[yCr*W+2*sec+lx]++;
    }
    var out=ctx.createImageData(W,H), od=out.data;
    for(var q=0;q<W*H;q++){
      var idx=q*4;
      od[idx]=13; od[idx+1]=12; od[idx+2]=11; od[idx+3]=255;
      if(cY[q]){ var iy=Math.min(255,40+cY[q]*42); od[idx]=iy; od[idx+1]=iy; od[idx+2]=iy; }
      if(cCb[q]){ od[idx]=Math.max(od[idx],30); od[idx+1]=Math.min(255,40+cCb[q]*36); od[idx+2]=Math.min(255,60+cCb[q]*46); }
      if(cCr[q]){ od[idx]=Math.min(255,60+cCr[q]*46); od[idx+1]=Math.min(255,40+cCr[q]*30); od[idx+2]=Math.max(od[idx+2],30); }
    }
    ctx.putImageData(out,0,0);
    ctx.strokeStyle="rgba(255,255,255,.14)"; ctx.lineWidth=1; ctx.beginPath();
    [0.25,0.5,0.75].forEach(function(f){ var y=Math.round(H*f)+0.5; ctx.moveTo(0,y); ctx.lineTo(W,y); });
    ctx.stroke();
    ctx.strokeStyle="rgba(255,255,255,.22)"; ctx.beginPath();
    [1/3,2/3].forEach(function(f){ var x=Math.round(W*f)+0.5; ctx.moveTo(x,0); ctx.lineTo(x,H); });
    ctx.stroke();
    ctx.fillStyle="rgba(255,255,255,.55)"; ctx.font="9px 'IBM Plex Mono',monospace";
    ctx.fillText("Y",4,H-4); ctx.fillText("Cb",sec+4,H-4); ctx.fillText("Cr",2*sec+4,H-4);
    ctx.fillText("100",W-22,10); ctx.fillText("0",W-10,H-4);
  })();
  /* --- Cromaticidad CIE 1931 xy --- */
  (function(){
    var cv=document.getElementById("scopeCIE"); if(!cv) return;
    var W=cv.width, H=cv.height, ctx=cv.getContext("2d");
    var out=ctx.createImageData(W,H), od=out.data;
    for(var q=0;q<W*H;q++){ var idx0=q*4; od[idx0]=13; od[idx0+1]=12; od[idx0+2]=11; od[idx0+3]=255; }
    function mapX(x){ return x/0.8*(W-16)+8; }
    function mapY(y){ return H-8-(y/0.9*(H-16)); }
    for(var p2=0;p2<total;p2++){
      var Rl=srgbLin(rs[p2]), Gl=srgbLin(gs[p2]), Bl=srgbLin(bs[p2]);
      var X=0.4124564*Rl + 0.3575761*Gl + 0.1804375*Bl;
      var Yv=0.2126729*Rl + 0.7151522*Gl + 0.0721750*Bl;
      var Z=0.0193339*Rl + 0.1191920*Gl + 0.9503041*Bl;
      var sum=X+Yv+Z; if(sum<=0.00001) continue;
      var px=Math.round(mapX(X/sum)), py=Math.round(mapY(Yv/sum));
      if(px<0||px>=W||py<0||py>=H) continue;
      var idx=(py*W+px)*4;
      od[idx]=rs[p2]; od[idx+1]=gs[p2]; od[idx+2]=bs[p2];
    }
    ctx.putImageData(out,0,0);
    var locus=[[0.1741,0.0050],[0.1733,0.0048],[0.1714,0.0051],[0.1644,0.0109],[0.1440,0.0297],[0.0913,0.1327],[0.0082,0.5384],[0.0743,0.8338],[0.2296,0.7543],[0.3731,0.6245],[0.5125,0.4866],[0.6270,0.3725],[0.6915,0.3083],[0.7190,0.2809],[0.7334,0.2666],[0.7347,0.2653]];
    ctx.beginPath();
    locus.forEach(function(pt,i){ var x=mapX(pt[0]), y=mapY(pt[1]); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.closePath();
    ctx.fillStyle="rgba(255,255,255,.05)"; ctx.fill();
    ctx.strokeStyle="rgba(255,255,255,.38)"; ctx.lineWidth=1; ctx.stroke();
    var tri=[[0.64,0.33],[0.30,0.60],[0.15,0.06]];
    ctx.beginPath();
    tri.forEach(function(pt,i){ var x=mapX(pt[0]), y=mapY(pt[1]); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.closePath(); ctx.strokeStyle="rgba(255,255,255,.75)"; ctx.setLineDash([4,3]); ctx.stroke(); ctx.setLineDash([]);
    var wx=mapX(0.3127), wy=mapY(0.3290);
    ctx.strokeStyle="rgba(255,255,255,.85)"; ctx.beginPath();
    ctx.moveTo(wx-5,wy); ctx.lineTo(wx+5,wy); ctx.moveTo(wx,wy-5); ctx.lineTo(wx,wy+5); ctx.stroke();
    ctx.fillStyle="rgba(255,255,255,.60)"; ctx.font="9px 'IBM Plex Mono',monospace";
    ctx.fillText("D65",wx+7,wy+3);
    ctx.fillText("sRGB",mapX(0.30)+4,mapY(0.60)-5);
    ctx.fillText("x →",W-30,H-4); ctx.fillText("y",4,11);
  })();
  /* --- Histograma de luminancia --- */
  (function(){
    var cv=document.getElementById("scopeHistLuma"); if(!cv) return;
    var W=cv.width, H=cv.height, ctx=cv.getContext("2d");
    ctx.fillStyle="#0d0c0b"; ctx.fillRect(0,0,W,H);
    var maxC=1, v;
    for(v=0;v<256;v++) if(histL[v]>maxC) maxC=histL[v];
    ctx.fillStyle="rgba(235,232,225,.88)"; ctx.beginPath(); ctx.moveTo(0,H);
    for(v=0;v<256;v++){
      var x=v/255*W, hh=Math.sqrt(histL[v]/maxC)*(H-16);
      ctx.lineTo(x, H-hh);
    }
    ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
    var p50=pctFromHist(histL,50);
    ctx.strokeStyle="rgba(232,73,15,.95)"; ctx.lineWidth=1; ctx.beginPath();
    var mx=p50/255*W; ctx.moveTo(mx+0.5,4); ctx.lineTo(mx+0.5,H-10); ctx.stroke();
    ctx.fillStyle="rgba(255,255,255,.60)"; ctx.font="9px 'IBM Plex Mono',monospace";
    ctx.fillText("0",4,H-3); ctx.fillText("mediana "+p50,Math.min(W-72,mx+4),11); ctx.fillText("255",W-24,H-3);
    scopeGridLines(ctx,W,H,false);
  })();
  /* --- False color (exposición por IRE) ---
     Mismos colores por zona IRE, misma leyenda y mismos datos que
     antes. El mapa en sí se calcula en alta resolución, igual que el
     de Diferencia: píxel a píxel desde la vista previa a su
     resolución real (hasta 1280px en el lado mayor), en vez de
     estirar la muestra de 256px de los demás scopes, que era lo que
     lo dejaba pixeleado. El lienzo guarda ese bitmap completo y el
     CSS lo reduce al ancho del panel, así que se ve nítido en
     retina y al ampliarlo. */
  (function(){
    var cv=document.getElementById("scopeFalse"); if(!cv) return;
    function falseRGB(ire){
      if(ire<5) return [123,47,247];
      if(ire<20) return [36,86,230];
      if(ire<35) return [31,157,138];
      if(ire<45) return [87,178,74];
      if(ire<55) return [154,154,154];
      if(ire<70) return [217,200,74];
      if(ire<85) return [240,161,58];
      if(ire<95) return [232,73,15];
      return [255,42,42];
    }
    (function renderFalseHiRes(){
      var srcW=previewCanvas.width, srcH=previewCanvas.height;
      if(!srcW || !srcH) return;
      var dScale=Math.min(1280/srcW, 1280/srcH, 1);
      var dw=Math.max(8, Math.round(srcW*dScale)), dh=Math.max(8, Math.round(srcH*dScale));
      var fData;
      try{
        falseSample.width=dw; falseSample.height=dh;
        var fctx=falseSample.getContext("2d");
        fctx.imageSmoothingEnabled=true; fctx.imageSmoothingQuality="high";
        fctx.drawImage(previewCanvas,0,0,dw,dh);
        fData=fctx.getImageData(0,0,dw,dh).data;
      }catch(e){ return; }
      if(cv.width!==dw) cv.width=dw;
      if(cv.height!==dh) cv.height=dh;
      var ctx=cv.getContext("2d");
      var out=ctx.createImageData(dw,dh), od=out.data;
      var nPix=dw*dh;
      for(var hp=0;hp<nPix;hp++){
        var hi=hp*4;
        var lum=Math.round(0.2126*fData[hi] + 0.7152*fData[hi+1] + 0.0722*fData[hi+2]);
        var fc=falseRGB(lum/255*100);
        od[hi]=fc[0]; od[hi+1]=fc[1]; od[hi+2]=fc[2]; od[hi+3]=255;
      }
      ctx.putImageData(out,0,0);
    })();
  })();
  /* --- Diferencia: original vs variante seleccionada SIN dithering ---
     Las cifras (match, SSIM, px que difieren, regiones) salen de la
     muestra de 256px de los demás scopes, como antes. El mapa de calor
     en sí se dibuja aparte, en alta resolución (ver renderDiffHiRes).
     Sin cambio = negro; con cambio = amarillo → naranja → rojo
     según la magnitud. */
  (function(){
    var cv=document.getElementById("scopeDiff"); if(!cv) return;
    if(!previewWork || !previewWork.width) return;
    var oData;
    try{
      diffSample.width=sw; diffSample.height=sh;
      var dctx=diffSample.getContext("2d");
      dctx.imageSmoothingEnabled=true; dctx.imageSmoothingQuality="high";
      dctx.drawImage(previewWork,0,0,sw,sh);
      oData=dctx.getImageData(0,0,sw,sh).data;
    }catch(e){ return; }
    /* La graduada que se compara es la versión SIN dithering
       (previewClean), nunca la vista previa con dithering: el ruido ±1
       del Bayer encendería el mapa entero y bajaría el % de coincidencia
       aunque el grado fuera el mismo. Sin copia limpia válida (celda
       original) se cae a la muestra de la vista previa, que en la
       original es la propia imagen sin tocar. */
    var cleanSrc=(previewCell!==CENTER_CELL && previewClean && previewClean.width===pw && previewClean.height===ph) ? previewClean : null;
    var gd=d, gLumas=lumas;
    if(cleanSrc){
      try{
        diffGradSample.width=sw; diffGradSample.height=sh;
        var gctx0=diffGradSample.getContext("2d");
        gctx0.imageSmoothingEnabled=true; gctx0.imageSmoothingQuality="high";
        gctx0.drawImage(cleanSrc,0,0,sw,sh);
        gd=gctx0.getImageData(0,0,sw,sh).data;
        gLumas=new Float32Array(total);
        for(var gp=0;gp<total;gp++){ var gi=gp*4; gLumas[gp]=0.2126*gd[gi] + 0.7152*gd[gi+1] + 0.0722*gd[gi+2]; }
      }catch(e){ gd=d; gLumas=lumas; }
    }
    var changed=new Uint8Array(total), mag=new Float32Array(total);
    var differ=0;
    var sumO=0, sumG2=0;
    var oLumas=new Float32Array(total);
    for(var p2=0;p2<total;p2++){
      var idx=p2*4;
      var dr=gd[idx]-oData[idx], dg=gd[idx+1]-oData[idx+1], db=gd[idx+2]-oData[idx+2];
      var mxc=Math.max(Math.abs(dr),Math.abs(dg),Math.abs(db));
      var m=Math.sqrt(dr*dr+dg*dg+db*db)/441.673;
      mag[p2]=m;
      if(mxc>4){ changed[p2]=1; differ++; }
      var lo=0.2126*oData[idx] + 0.7152*oData[idx+1] + 0.0722*oData[idx+2];
      oLumas[p2]=lo; sumO+=lo; sumG2+=gLumas[p2];
    }
    /* Regiones: componentes conexas (4 vecinos) de píxeles cambiados */
    var regions=0;
    var seen=new Uint8Array(total), stack=[];
    for(var s0=0;s0<total;s0++){
      if(!changed[s0] || seen[s0]) continue;
      regions++; seen[s0]=1; stack.length=0; stack.push(s0);
      while(stack.length){
        var cur=stack.pop(), cx=cur%sw, cy=(cur/sw)|0;
        if(cx>0){ var n1=cur-1; if(changed[n1]&&!seen[n1]){ seen[n1]=1; stack.push(n1); } }
        if(cx<sw-1){ var n2=cur+1; if(changed[n2]&&!seen[n2]){ seen[n2]=1; stack.push(n2); } }
        if(cy>0){ var n3=cur-sw; if(changed[n3]&&!seen[n3]){ seen[n3]=1; stack.push(n3); } }
        if(cy<sh-1){ var n4=cur+sw; if(changed[n4]&&!seen[n4]){ seen[n4]=1; stack.push(n4); } }
      }
    }
    /* SSIM global sobre luma */
    var meanO=sumO/total, meanG=sumG2/total, varO=0, varG=0, cov=0;
    for(var p3=0;p3<total;p3++){
      var do2=oLumas[p3]-meanO, dg2=gLumas[p3]-meanG;
      varO+=do2*do2; varG+=dg2*dg2; cov+=do2*dg2;
    }
    varO/=total; varG/=total; cov/=total;
    var C1=6.5025, C2=58.5225, den=(meanO*meanO+meanG*meanG+C1)*(varO+varG+C2);
    var ssim= den>0 ? ((2*meanO*meanG+C1)*(2*cov+C2))/den : 1;
    if(ssim>1) ssim=1; if(ssim<-1) ssim=-1;
    /* Mapa de calor en alta resolución: se recalcula píxel a píxel
       desde la vista previa a su resolución real (hasta 1280px en el
       lado mayor), en vez de estirar la muestra de 256px de los scopes,
       que era lo que lo dejaba pixeleado. El lienzo guarda ese bitmap
       completo y el CSS lo reduce al ancho del panel, así que se ve
       nítido en retina y al ampliarlo. Las cifras de abajo siguen
       saliendo de la muestra de scopes, sin cambiar. */
    function heatRGB(t){
      if(t<0.55){ var f=t/0.55; return [255, Math.round(212+(138-212)*f), 0]; }
      var f2=(t-0.55)/0.45; return [255, Math.round(138+(30-138)*f2), Math.round(30*f2)];
    }
    (function renderDiffHiRes(){
      /* La graduada en alta resolución también es la limpia (sin
         dithering); solo si no hay copia limpia válida se usa la vista
         previa tal cual (celda original: es la imagen sin tocar). */
      var gradSrc=cleanSrc || previewCanvas;
      var srcW=gradSrc.width, srcH=gradSrc.height;
      if(!srcW || !srcH) return;
      var dScale=Math.min(1280/srcW, 1280/srcH, 1);
      var dw=Math.max(8, Math.round(srcW*dScale)), dh=Math.max(8, Math.round(srcH*dScale));
      var gData, oDataHi;
      try{
        diffGradSample.width=dw; diffGradSample.height=dh;
        var gctx=diffGradSample.getContext("2d");
        gctx.imageSmoothingEnabled=true; gctx.imageSmoothingQuality="high";
        gctx.drawImage(gradSrc,0,0,dw,dh);
        gData=gctx.getImageData(0,0,dw,dh).data;
        diffSample.width=dw; diffSample.height=dh;
        var dctx2=diffSample.getContext("2d");
        dctx2.imageSmoothingEnabled=true; dctx2.imageSmoothingQuality="high";
        dctx2.drawImage(previewWork,0,0,dw,dh);
        oDataHi=dctx2.getImageData(0,0,dw,dh).data;
      }catch(e){ return; }
      if(cv.width!==dw) cv.width=dw;
      if(cv.height!==dh) cv.height=dh;
      var ctx=cv.getContext("2d");
      var out=ctx.createImageData(dw,dh), od=out.data;
      var nPix=dw*dh;
      for(var hp=0;hp<nPix;hp++){
        var hi=hp*4;
        var hdr=gData[hi]-oDataHi[hi], hdg=gData[hi+1]-oDataHi[hi+1], hdb=gData[hi+2]-oDataHi[hi+2];
        var hmx=Math.max(Math.abs(hdr),Math.abs(hdg),Math.abs(hdb));
        od[hi+3]=255;
        if(hmx<=4){ od[hi]=0; od[hi+1]=0; od[hi+2]=0; continue; }
        var hm=Math.sqrt(hdr*hdr+hdg*hdg+hdb*hdb)/441.673;
        var t=Math.min(1, Math.sqrt(hm)*1.1);
        var hc=heatRGB(t);
        od[hi]=hc[0]; od[hi+1]=hc[1]; od[hi+2]=hc[2];
      }
      ctx.putImageData(out,0,0);
    })();
    /* Cifras bajo el mapa (px difieren escalados a la imagen completa) */
    var matchPct= total>0 ? (total-differ)/total*100 : 100;
    var fullTotal=(sW>0 && sH>0) ? sW*sH : total;
    var differFull=Math.round(differ/total*fullTotal);
    var elM=document.getElementById("diffMatch"); if(elM) elM.textContent=matchPct.toFixed(1)+"% match";
    var elS=document.getElementById("diffSSIM"); if(elS) elS.textContent="SSIM "+ssim.toFixed(3);
    var elP=document.getElementById("diffPx"); if(elP) elP.textContent=differFull.toLocaleString("es-MX")+" px difieren";
    var elR=document.getElementById("diffRegions"); if(elR) elR.textContent=regions.toLocaleString("es-MX")+(regions===1?" región":" regiones");
  })();
  /* --- Lecturas numéricas --- */
  scopeEmpty.hidden=true; scopeContent.hidden=false;
  scopeTarget.textContent=(previewTitle ? previewTitle.textContent : "")+" · "+(genBadge ? genBadge.textContent : "");
  function setStat(id, txt, warn){
    var el=document.getElementById(id); if(!el) return;
    el.textContent=txt; el.classList.toggle("warn", !!warn);
  }
  setStat("stBright", Math.round(meanL)+" / 255 · "+Math.round(meanL/255*100)+"%");
  setStat("stContrast", (p95-p5)+" ("+p5+"–"+p95+")");
  setStat("stSat", Math.round(sumSat/total*100)+"%");
  setStat("stHue", hasHue ? domDeg+"° · "+hueNameEs(domDeg) : "Sin tono (gris)");
  var pctS=clipS/total*100, pctH=clipH/total*100;
  setStat("stShadows", pctS.toFixed(1)+"%", pctS>5);
  setStat("stHighlights", pctH.toFixed(1)+"%", pctH>5);
  setStat("stMeanR", String(Math.round(meanR)));
  setStat("stMeanG", String(Math.round(meanG)));
  setStat("stMeanB", String(Math.round(meanB)));
  var rb= meanB>0 ? meanR/meanB : 0;
  var cast= rb>1.08 ? "Cálido" : rb<0.92 ? "Frío" : "Neutro";
  setStat("stWB", cast+" · R/B "+rb.toFixed(2));
  var p1=pctFromHist(histL,1), p50b=pctFromHist(histL,50), p99=pctFromHist(histL,99);
  setStat("stIRE", (meanL/255*100).toFixed(1)+" IRE");
  setStat("stMedian", String(p50b)+" / 255");
  setStat("stBlack", String(p1));
  setStat("stWhite", String(p99));
  var linLo=SRGB_TO_LINEAR[Math.max(1,p1)], linHi=SRGB_TO_LINEAR[p99];
  var stops= (linHi>0 && linLo>0) ? Math.log(linHi/linLo)/Math.log(2) : 0;
  setStat("stRange", stops>0 ? stops.toFixed(1)+" stops (p99/p1)" : "—");
  var mRl=SRGB_TO_LINEAR[Math.round(meanR)], mGl=SRGB_TO_LINEAR[Math.round(meanG)], mBl=SRGB_TO_LINEAR[Math.round(meanB)];
  var mX=0.4124564*mRl + 0.3575761*mGl + 0.1804375*mBl;
  var mY=0.2126729*mRl + 0.7151522*mGl + 0.0721750*mBl;
  var mZ=0.0193339*mRl + 0.1191920*mGl + 0.9503041*mBl;
  var mSum=mX+mY+mZ, cctTxt="—";
  if(mSum>0.00001){
    var cx=mX/mSum, cy=mY/mSum;
    var nn=(cx-0.3320)/(0.1858-cy);
    var cct=449*nn*nn*nn + 3525*nn*nn + 6823.3*nn + 5520.33;
    if(cct>=2000 && cct<=20000) cctTxt=Math.round(cct/50)*50+" K aprox.";
  }
  setStat("stCCT", cctTxt);
  var chanClip=0;
  for(var cp=0;cp<total;cp++){ if(rs[cp]<=2||rs[cp]>=253||gs[cp]<=2||gs[cp]>=253||bs[cp]<=2||bs[cp]>=253) chanClip++; }
  var pctClip=chanClip/total*100;
  setStat("stChanClip", pctClip.toFixed(1)+"%", pctClip>8);
}
/* ---------- Cubo 3D de la LUT horneada ----------
   Vista tipo LUT Cube Analyzer: cada punto es un nodo de la malla de
   la LUT horneada del genoma en vista previa (todos sus efectos en una
   sola LUT), situado en el color de salida y pintado con ese color, a
   brillo completo. Se dibujan TODOS los nodos de la rejilla mostrada,
   sin muestreo: 33³ = 35937 puntos mientras el horneado es 33³ y
   65³ = 274625 puntos cuando el horneado 65³ está listo. Tamaño de
   punto fino: CUBE_PT = 0.9, 1/6 del anterior (5.4), con un mínimo de
   1 px de diámetro para que ningún punto desaparezca. Con esa cantidad
   de puntos el dibujo no usa arcos por punto: las posiciones mezcladas
   y los colores se cachean por (rejilla, intensidad, clipping, masked)
   y cada fotograma solo proyecta, ordena por profundidad con un
   counting sort de 256 cubetas y rasteriza los puntos en un ImageData
   fuera de pantalla que se vuelca de una vez sobre el lienzo.
   El control principal es el slider de intensidad (100% por defecto):
   mezcla entre la identidad y la LUT horneada. A su derecha, el check
   Clipping (apagado por defecto) activa el modo show clipping: los
   puntos cuya salida llega a 0 o 1 en un canal donde la entrada no
   estaba en ese extremo (color recortado por la LUT) se quedan a brillo
   completo y un poco más grandes, y el resto se oscurece. Junto a él, el
   check Masked (apagado por defecto) oculta los nodos que no afectan a
   ningún píxel de la imagen: solo se dibujan los 8 nodos esquina de las
   celdas de la rejilla mostrada (33³ o 65³) en las que cae algún píxel
   muestreado de la imagen original (muestreo reducido a ~32768 píxeles,
   máscara cacheada por imagen y tamaño de rejilla). Gira solo;
   arrastrar lo gira a mano y la rotación automática se reanuda a los
   pocos segundos. La escala de proyección se ajusta a las esquinas en
   cada fotograma para que el cubo se vea completo en el lienzo. */
var CUBE_PT=0.9;    /* radio base del punto en px: 1/6 del anterior (5.4) */
var CUBE_PT_MIN_R=0.5; /* radio mínimo: 1 px de diámetro, para que el punto no desaparezca */
var cubeCanvas=document.getElementById("scopeCube"),
    sCubeIntensity=document.getElementById("sCubeIntensity"),
    chkCubeClipping=document.getElementById("chkCubeClipping"),
    chkCubeMasked=document.getElementById("chkCubeMasked");
var cubePoints=null, cubeSig=null, cubeIntensity=1, cubeShowClipping=false, cubeShowMasked=false;
/* Rejilla horneada que se está mostrando (33 o 65) y máscara de nodos
   usados por la imagen, cacheada por tamaño de rejilla y por imagen. */
var cubeGridSize=LUT_SIZE;
var cubeMaskCache={}, cubeMaskCacheSrc=null;
var cubeSampleCanvas=document.createElement("canvas"), cubeSampleData=null, cubeSampleSrc=null;
/* Píxeles muestreados de la imagen original: se dibuja reducida a
   ~32768 píxeles en total, suficiente para cubrir sus regiones de color. */
function cubeSamplePixels(){
  if(!source || !sW || !sH) return null;
  if(cubeSampleData && cubeSampleSrc===source) return cubeSampleData;
  var sc=Math.min(1, Math.sqrt(32768/Math.max(1, sW*sH)));
  var w=Math.max(1, Math.round(sW*sc)), h=Math.max(1, Math.round(sH*sc));
  cubeSampleCanvas.width=w; cubeSampleCanvas.height=h;
  var cx=cubeSampleCanvas.getContext("2d");
  cx.imageSmoothingEnabled=true; cx.imageSmoothingQuality="high";
  try{ cx.drawImage(source,0,0,w,h); cubeSampleData=cx.getImageData(0,0,w,h); }catch(e){ cubeSampleData=null; }
  cubeSampleSrc=source;
  return cubeSampleData;
}
/* Máscara de nodos usados: cada píxel muestreado cae en una celda de la
   rejilla (floor(c*(S-1)) por eje, con tope S-2) y marca sus 8 nodos
   esquina. Solo esos nodos se dibujan con Masked activo. El cálculo es
   sobre ~32768 píxeles como máximo: unos pocos ms, no bloquea la UI. */
function cubeUsedMask(S){
  if(cubeMaskCacheSrc!==source){ cubeMaskCache={}; cubeMaskCacheSrc=source; }
  if(cubeMaskCache[S]) return cubeMaskCache[S];
  var img=cubeSamplePixels();
  if(!img) return null;
  var mask=new Uint8Array(S*S*S), d=img.data, m1=S-1, maxCell=S-2;
  for(var i=0;i<d.length;i+=4){
    var cr=Math.min(maxCell, Math.floor(d[i]/255*m1));
    var cg=Math.min(maxCell, Math.floor(d[i+1]/255*m1));
    var cb=Math.min(maxCell, Math.floor(d[i+2]/255*m1));
    for(var db=0;db<2;db++) for(var dg=0;dg<2;dg++) for(var dr=0;dr<2;dr++){
      mask[((cb+db)*S+(cg+dg))*S+(cr+dr)]=1;
    }
  }
  cubeMaskCache[S]=mask;
  return mask;
}
var cubeRotY=0.65, cubeRotX=-0.55, cubeDrag=null, cubeLastInteract=0, cubeRaf=null;
function cubeReducedMotion(){ return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
function cubeSignature(g){ try{ return JSON.stringify(chainStepsOf(g)); }catch(e){ return null; } }
function updateCubeData(){
  if(!cubeCanvas) return;
  var g=null;
  try{ g=genomeAtCell(previewCell); }catch(e){}
  if(!g){ cubePoints=null; cubeSig=null; return; }
  var sig=cubeSignature(g);
  if(sig!==null && sig===cubeSig && cubePoints){ scheduleCubeAnim(); return; }
  var data;
  try{ data=buildBakedLut33(g); }catch(e){ return; }
  cubeSig=sig;
  cubeSetPoints(LUT_SIZE, data); /* rejilla completa 33³: 35937 puntos, sin muestreo */
  scheduleCubeAnim();
  /* Los puntos se refinan con la LUT horneada a 65³ en cuanto está:
     se genera bajo demanda y se hornea troceado, sin bloquear. */
  if(!(typeof genePhase!=="undefined" && genePhase)){
    var mySig=sig;
    ensure65ForGenome(g, function(){
      if(cubeSig!==mySig) return;
      buildBakedLutAsync(g, null, function(data65){
        if(cubeSig!==mySig || !data65) return;
        cubeSetPoints(LUT65_SIZE, data65); /* rejilla completa 65³: 274625 puntos, sin muestreo */
        scheduleCubeAnim();
      });
    });
  }
}
/* Conjunto completo de puntos de la rejilla horneada mostrada:
   cubePoints = { size:S, count:S³, inArr, outArr } con las coordenadas
   de entrada (rejilla regular) y de salida (LUT horneada) en arreglos
   tipados planos, sin objetos por punto. cubePointsVer invalida la
   caché de mezcla cada vez que se sustituye el conjunto. */
var cubePointsVer=0, cubeBlend=null;
var cubeRasterCanvas=document.createElement("canvas"), cubeRasterCtx=null, cubeRasterImg=null;
var cubeProjX=null, cubeProjY=null, cubeProjSf=null, cubeProjBk=null, cubeOrder=null;
var cubeBucketCount=new Uint32Array(256), cubeBucketStart=new Uint32Array(256);
function cubeSetPoints(S, data){
  var count=S*S*S, inArr=new Float32Array(count*3), p=0, m1=S-1;
  for(var bi=0; bi<S; bi++) for(var gi=0; gi<S; gi++) for(var ri=0; ri<S; ri++){
    inArr[p++]=ri/m1; inArr[p++]=gi/m1; inArr[p++]=bi/m1;
  }
  cubeGridSize=S;
  cubePoints={ size:S, count:count, inArr:inArr, outArr:data };
  cubePointsVer++;
  cubeBlend=null;
}
/* Caché de mezcla: posiciones finales (identidad↔LUT según intensidad),
   colores, marcas de recorte y lista de nodos visibles (todos, o solo
   los de la máscara con Masked). Se recalcula solo cuando cambia la
   rejilla, la intensidad, Clipping, Masked o la imagen de la máscara;
   la rotación por fotograma no la toca. */
function cubeBuildBlend(){
  var mask=(cubeShowMasked ? cubeUsedMask(cubeGridSize) : null);
  if(cubeBlend && cubeBlend.ver===cubePointsVer && cubeBlend.t===cubeIntensity
     && cubeBlend.clipping===cubeShowClipping && cubeBlend.masked===cubeShowMasked
     && cubeBlend.mask===mask) return cubeBlend;
  var cp=cubePoints, count=cp.count, inA=cp.inArr, outA=cp.outArr, t=cubeIntensity;
  var pos=new Float32Array(count*3), col=new Uint8Array(count*3), clip=new Uint8Array(count);
  var eps=0.004;
  for(var i=0;i<count;i++){
    var j=i*3, ix=inA[j], iy=inA[j+1], iz=inA[j+2];
    var bx=ix+(outA[j]-ix)*t, by=iy+(outA[j+1]-iy)*t, bz=iz+(outA[j+2]-iz)*t;
    pos[j]=bx; pos[j+1]=by; pos[j+2]=bz;
    var rr=Math.round(bx*255), gg=Math.round(by*255), bb=Math.round(bz*255);
    /* Recorte: la salida llega a 0 o 1 en un canal donde la entrada no
       estaba en ese extremo; es la LUT la que recorta ese color. */
    var cl=(bx<=eps && ix>eps) || (bx>=1-eps && ix<1-eps)
        || (by<=eps && iy>eps) || (by>=1-eps && iy<1-eps)
        || (bz<=eps && iz>eps) || (bz>=1-eps && iz<1-eps);
    clip[i]=cl?1:0;
    if(cubeShowClipping && !cl){ rr=Math.round(rr*0.15); gg=Math.round(gg*0.15); bb=Math.round(bb*0.15); }
    col[j]=rr; col[j+1]=gg; col[j+2]=bb;
  }
  var vis, visCount;
  if(mask){
    vis=new Uint32Array(count); visCount=0;
    for(var k=0;k<count;k++) if(mask[k]) vis[visCount++]=k;
  }else{
    vis=null; visCount=count; /* null = todos los nodos, en orden */
  }
  cubeBlend={ ver:cubePointsVer, t:t, clipping:cubeShowClipping, masked:cubeShowMasked,
              mask:mask, pos:pos, col:col, clip:clip, vis:vis, visCount:visCount };
  return cubeBlend;
}
function cubeProject(x, y, z, W, H, cosY, sinY, cosX, sinX, scale){
  var X=x-0.5, Y=y-0.5, Z=z-0.5;
  var x1=X*cosY + Z*sinY, z1=-X*sinY + Z*cosY;
  var y2=Y*cosX - z1*sinX, z2=Y*sinX + z1*cosX;
  var f=2.6, sf=f/(f+z2);
  if(scale===undefined) scale=Math.min(W,H)*0.94;
  return { sx:W/2 + x1*scale*sf, sy:H/2 - y2*scale*sf, z:z2, sf:sf };
}
function drawCube(){
  if(!cubeCanvas) return;
  var W=cubeCanvas.width, H=cubeCanvas.height, ctx=cubeCanvas.getContext("2d");
  ctx.fillStyle="#050505"; ctx.fillRect(0,0,W,H);
  var cosY=Math.cos(cubeRotY), sinY=Math.sin(cubeRotY), cosX=Math.cos(cubeRotX), sinX=Math.sin(cubeRotX);
  /* Escala de ajuste: se mide la extensión proyectada de las esquinas
     con escala 1 y se elige la escala que hace caber el cubo entero en
     el lienzo, con un pequeño margen, en cualquier rotación. */
  var maxX=0.001, maxY=0.001;
  for(var pi=0;pi<8;pi++){
    var pp=cubeProject(pi&1, (pi>>1)&1, (pi>>2)&1, W, H, cosY, sinY, cosX, sinX, 1);
    var ax=Math.abs(pp.sx-W/2), ay=Math.abs(pp.sy-H/2);
    if(ax>maxX) maxX=ax;
    if(ay>maxY) maxY=ay;
  }
  var fitScale=Math.min((W/2-6)/maxX, (H/2-6)/maxY);
  /* Aristas del cubo de referencia, cada una con degradado entre los
     colores de sus dos esquinas, como en el analizador de referencia. */
  var corners=[];
  for(var ci=0;ci<8;ci++) corners.push(cubeProject(ci&1, (ci>>1)&1, (ci>>2)&1, W, H, cosY, sinY, cosX, sinX, fitScale));
  var cornerRGB=[[0,0,0],[255,0,0],[0,255,0],[255,255,0],[0,0,255],[255,0,255],[0,255,255],[255,255,255]];
  ctx.lineWidth=1.2;
  for(var a=0;a<8;a++) for(var b=a+1;b<8;b++){
    var diff=a^b;
    if(diff!==1 && diff!==2 && diff!==4) continue; /* solo aristas: difieren en un eje */
    var pa=corners[a], pb=corners[b], ca=cornerRGB[a], cb=cornerRGB[b];
    var grad=ctx.createLinearGradient(pa.sx,pa.sy,pb.sx,pb.sy);
    grad.addColorStop(0,"rgba("+ca[0]+","+ca[1]+","+ca[2]+",.85)");
    grad.addColorStop(1,"rgba("+cb[0]+","+cb[1]+","+cb[2]+",.85)");
    ctx.strokeStyle=grad; ctx.beginPath(); ctx.moveTo(pa.sx,pa.sy); ctx.lineTo(pb.sx,pb.sy); ctx.stroke();
  }
  if(!cubePoints) return;
  var blend=cubeBuildBlend();
  var pos=blend.pos, col=blend.col, clipFlags=blend.clip, vis=blend.vis, visCount=blend.visCount;
  /* Búferes por fotograma reutilizados (proyección y orden de dibujo). */
  if(!cubeProjX || cubeProjX.length<cubePoints.count){
    cubeProjX=new Float32Array(cubePoints.count);
    cubeProjY=new Float32Array(cubePoints.count);
    cubeProjSf=new Float32Array(cubePoints.count);
    cubeProjBk=new Uint8Array(cubePoints.count);
    cubeOrder=new Uint32Array(cubePoints.count);
  }
  /* Proyección de los nodos visibles y counting sort por profundidad
     (256 cubetas, orden de dibujo descendente en z, como antes). */
  cubeBucketCount.fill(0);
  var fP=2.6, halfW=W/2, halfH=H/2;
  for(var vi=0;vi<visCount;vi++){
    var ni=vis?vis[vi]:vi, nj=ni*3;
    var X=pos[nj]-0.5, Y=pos[nj+1]-0.5, Z=pos[nj+2]-0.5;
    var x1=X*cosY + Z*sinY, z1=-X*sinY + Z*cosY;
    var y2=Y*cosX - z1*sinX, z2=Y*sinX + z1*cosX;
    var sf=fP/(fP+z2);
    cubeProjX[ni]=halfW + x1*fitScale*sf;
    cubeProjY[ni]=halfH - y2*fitScale*sf;
    cubeProjSf[ni]=sf;
    var bk=((z2+1)*127.5)|0; if(bk<0) bk=0; else if(bk>255) bk=255;
    cubeProjBk[ni]=bk;
    cubeBucketCount[bk]++;
  }
  var acc=0;
  for(var bIdx=255;bIdx>=0;bIdx--){ cubeBucketStart[bIdx]=acc; acc+=cubeBucketCount[bIdx]; }
  var fillPos=cubeBucketStart.slice();
  for(var vj=0;vj<visCount;vj++){
    var nj2=vis?vis[vj]:vj;
    cubeOrder[fillPos[cubeProjBk[nj2]]++]=nj2;
  }
  /* Rasterización por lotes en una sola pasada: cada punto se escribe
     como 1 px (o un bloque de 2×2/3×3 si su radio proyectado lo pide)
     en el ImageData fuera de pantalla; el último en escribirse manda,
     igual que con el pintado ordenado por profundidad. */
  if(cubeRasterCanvas.width!==W || cubeRasterCanvas.height!==H){
    cubeRasterCanvas.width=W; cubeRasterCanvas.height=H;
    cubeRasterCtx=cubeRasterCanvas.getContext("2d");
    cubeRasterImg=cubeRasterCtx.createImageData(W,H);
  }
  var pix=cubeRasterImg.data;
  pix.fill(0);
  var rowStride=W*4;
  for(var oi=0;oi<visCount;oi++){
    var idx=cubeOrder[oi], j3=idx*3;
    var sxf=cubeProjX[idx], syf=cubeProjY[idx];
    if(sxf<-1 || syf<-1 || sxf>W || syf>H) continue;
    var rad=CUBE_PT*cubeProjSf[idx];
    if(rad<CUBE_PT_MIN_R) rad=CUBE_PT_MIN_R;
    if(cubeShowClipping && clipFlags[idx]) rad*=1.3;
    var cxp=(sxf+0.5)|0, cyp=(syf+0.5)|0;
    var rr=col[j3], gg=col[j3+1], bb=col[j3+2];
    var o=(cyp*W+cxp)*4;
    pix[o]=rr; pix[o+1]=gg; pix[o+2]=bb; pix[o+3]=255;
    if(rad>=1){ /* diámetro ≥ 2 px: se completa el bloque 2×2 (3×3 si el recorte lo agranda) */
      var big=cubeShowClipping && clipFlags[idx] && rad>=1.3;
      var xa=big?cxp-1:cxp, xb=cxp+1, ya=big?cyp-1:cyp, yb=cyp+1;
      for(var yy=ya;yy<=yb;yy++){
        if(yy<0 || yy>=H) continue;
        var rowBase=yy*rowStride;
        for(var xx=xa;xx<=xb;xx++){
          if(xx<0 || xx>=W || (xx===cxp && yy===cyp)) continue;
          var o2=rowBase+xx*4;
          pix[o2]=rr; pix[o2+1]=gg; pix[o2+2]=bb; pix[o2+3]=255;
        }
      }
    }
  }
  cubeRasterCtx.putImageData(cubeRasterImg,0,0);
  ctx.drawImage(cubeRasterCanvas,0,0);
}
function cubeFrame(){
  cubeRaf=null;
  if(!cubeCanvas || !scopePanel || scopePanel.hidden || !scopeContent || scopeContent.hidden) return;
  if(!cubeDrag && !cubeReducedMotion() && performance.now()-cubeLastInteract>2200) cubeRotY+=0.0075;
  drawCube();
  cubeRaf=requestAnimationFrame(cubeFrame);
}
function scheduleCubeAnim(){
  if(cubeCanvas && cubeRaf===null) cubeRaf=requestAnimationFrame(cubeFrame);
}
if(cubeCanvas){
  cubeCanvas.addEventListener("pointerdown", function(e){
    cubeDrag={ x:e.clientX, y:e.clientY };
    cubeLastInteract=performance.now();
    try{ cubeCanvas.setPointerCapture(e.pointerId); }catch(err){}
    scheduleCubeAnim();
  });
  cubeCanvas.addEventListener("pointermove", function(e){
    if(!cubeDrag) return;
    cubeRotY += (e.clientX-cubeDrag.x)*0.008;
    cubeRotX += (e.clientY-cubeDrag.y)*0.008;
    if(cubeRotX>1.35) cubeRotX=1.35; if(cubeRotX<-1.35) cubeRotX=-1.35;
    cubeDrag={ x:e.clientX, y:e.clientY };
    cubeLastInteract=performance.now();
    if(cubeReducedMotion()) drawCube();
  });
  var cubeEndDrag=function(){ if(cubeDrag){ cubeDrag=null; cubeLastInteract=performance.now(); } };
  cubeCanvas.addEventListener("pointerup", cubeEndDrag);
  cubeCanvas.addEventListener("pointercancel", cubeEndDrag);
}
if(sCubeIntensity){
  sCubeIntensity.addEventListener("input", function(){
    cubeIntensity=parseFloat(sCubeIntensity.value)/100;
    if(cubeReducedMotion()) drawCube(); else scheduleCubeAnim();
  });
}
if(chkCubeClipping){
  chkCubeClipping.addEventListener("change", function(){
    cubeShowClipping=chkCubeClipping.checked;
    if(cubeReducedMotion()) drawCube(); else scheduleCubeAnim();
  });
}
if(chkCubeMasked){
  chkCubeMasked.addEventListener("change", function(){
    cubeShowMasked=chkCubeMasked.checked;
    if(cubeShowMasked) cubeUsedMask(cubeGridSize); /* precálculo de la máscara de la rejilla mostrada */
    if(cubeReducedMotion()) drawCube(); else scheduleCubeAnim();
  });
}

if(chkScopes && scopePanel){
  chkScopes.addEventListener("change", function(){
    scopePanel.hidden=!chkScopes.checked;
    stageLayout.classList.toggle("show-scopes", chkScopes.checked);
    if(chkScopes.checked) updateScopes();
    requestAnimationFrame(function(){ refreshPreviewResolution(); });
  });
}

/* ---------- Reordenar scopes desde el agarre de 6 puntos (3×2) ----------
   Arrastrar el agarre de la esquina superior derecha mueve ese panel
   entre los demás en tiempo real (ratón y tacto, vía Pointer Events).
   Con el agarre enfocado, las flechas también lo mueven un puesto. */
(function initScopeReorder(){
  var scopeGrid=document.querySelector(".scope-grid");
  if(!scopeGrid) return;
  var dragItem=null, dragGrip=null, startX=0, startY=0, dragging=false;
  function endDrag(){
    if(dragItem) dragItem.classList.remove("is-dragging");
    dragItem=null; dragGrip=null; dragging=false;
  }
  scopeGrid.querySelectorAll(".scope-grip").forEach(function(grip){
    grip.addEventListener("pointerdown", function(e){
      var item=grip.closest ? grip.closest(".scope-item") : null;
      if(!item) return;
      dragItem=item; dragGrip=grip; startX=e.clientX; startY=e.clientY; dragging=false;
      try{ grip.setPointerCapture(e.pointerId); }catch(err){}
      e.preventDefault();
    });
    grip.addEventListener("pointermove", function(e){
      if(!dragItem || dragGrip!==grip) return;
      if(!dragging){
        if(Math.abs(e.clientX-startX)+Math.abs(e.clientY-startY)<6) return;
        dragging=true; dragItem.classList.add("is-dragging");
      }
      var list=Array.prototype.slice.call(scopeGrid.querySelectorAll(".scope-item"));
      var dragIdx=list.indexOf(dragItem);
      for(var i=0;i<list.length;i++){
        var other=list[i];
        if(other===dragItem) continue;
        var r=other.getBoundingClientRect();
        if(e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom){
          if(dragIdx < list.indexOf(other)) scopeGrid.insertBefore(dragItem, other.nextSibling);
          else scopeGrid.insertBefore(dragItem, other);
          break;
        }
      }
    });
    grip.addEventListener("pointerup", endDrag);
    grip.addEventListener("pointercancel", endDrag);
    grip.addEventListener("click", function(e){ e.preventDefault(); });
    grip.addEventListener("keydown", function(e){
      if(e.key!=="ArrowUp" && e.key!=="ArrowDown" && e.key!=="ArrowLeft" && e.key!=="ArrowRight") return;
      var item=grip.closest ? grip.closest(".scope-item") : null;
      if(!item) return;
      var backward=(e.key==="ArrowUp" || e.key==="ArrowLeft");
      var sibling=backward ? item.previousElementSibling : item.nextElementSibling;
      if(!sibling) return;
      e.preventDefault();
      if(backward) scopeGrid.insertBefore(item, sibling);
      else scopeGrid.insertBefore(sibling, item);
      grip.focus();
    });
  });
})();



/* ---------- Sin imagen por defecto: arranque vacío ---------- */
(function initEmpty(){
  source=null; sW=0; sH=0; population=[]; generation=0; selected={};
  statusEl.textContent="Sin imagen";
  genBadge.textContent="Gen 0";
  selCountEl.textContent="0 elegidos";
  btnEvolve.disabled=true;
  document.querySelectorAll(".dl-btn").forEach(function(b){ b.disabled=true; });
  var emptyBtn=document.getElementById("btnLoadEmpty");
  if(emptyBtn) emptyBtn.addEventListener("click", function(){ fileInput.click(); });
  try{
    var pc=previewCanvas.getContext("2d"); pc.clearRect(0,0,previewCanvas.width,previewCanvas.height);
    var bc=beforeCanvas.getContext("2d"); bc.clearRect(0,0,beforeCanvas.width,beforeCanvas.height);
  }catch(e){}
  syncSelectionUI();
})();
})();
