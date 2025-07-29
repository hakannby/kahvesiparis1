const functions = require('firebase-functions');
const admin = require('firebase-admin');
const PDFDocument = require('pdfkit'); // PDF oluşturmak için
const fs = require('fs'); // Dosya işlemleri için
const path = require('path'); // Dosya yolu için
const os = require('os'); // Geçici dosya için

admin.initializeApp();

// 1. Firebase üzerinden çağrılacak fonksiyon
exports.generateDailyReport = functions.https.onCall(async (data, context) => {
  // 1.1. Sadece yöneticiler erişebilir
  if (!context.auth || context.auth.token.role !== 'yonetici') {
    throw new functions.https.HttpsError('unauthenticated', 'Yetkiniz yok!');
  }

  // 1.2. Kullanıcının seçtiği tarihi al (örnek: "2025-07-28")
  const selectedDate = data.date;
  const startDate = new Date(selectedDate);
  startDate.setHours(0, 0, 0, 0); // Günün başlangıcı 00:00:00
  const endDate = new Date(selectedDate);
  endDate.setHours(23, 59, 59, 999); // Günün sonu 23:59:59

  // 1.3. Firestore'dan sipariş verilerini çek
  const db = admin.firestore();
  const salesRef = db.collection('sales');
  const snapshot = await salesRef
    .where('timestamp', '>=', startDate)
    .where('timestamp', '<=', endDate)
    .get();

  // 1.4. Eğer sipariş yoksa hata döndür
  if (snapshot.empty) {
    return { message: 'Seçilen tarihte sipariş bulunamadı.' };
  }

  // 2. Rapor verilerini işle
  const reportData = {
    date: selectedDate,
    totalSales: 0,
    totalRevenue: 0,
    popularProducts: {},
  };

  // 2.1. Her siparişi rapora ekle
  snapshot.forEach((doc) => {
    const sale = doc.data();
    reportData.totalSales++;
    reportData.totalRevenue += sale.total || 0;

    // 2.2. Ürün satış adetlerini hesapla
    sale.items.forEach((item) => {
      reportData.popularProducts[item.product] =
        (reportData.popularProducts[item.product] || 0) + item.qty;
    });
  });

  // 3. PDF Oluşturma
  // 3.1. Geçici bir dosya yolu belirle (örnek: /tmp/report_2025-07-28.pdf)
  const tempFilePath = path.join(os.tmpdir(), `report_${selectedDate}.pdf`);

  // 3.2. PDF dokümanını oluştur
  const doc = new PDFDocument();
  const writeStream = fs.createWriteStream(tempFilePath);
  doc.pipe(writeStream);

  // 3.3. PDF İçeriğini Yaz
  doc.fontSize(20).text('KAHVECİM - GÜNLÜK RAPOR', { align: 'center' });
  doc.moveDown();
  doc.fontSize(14).text(`Tarih: ${selectedDate}`);
  doc.text(`Toplam Sipariş Sayısı: ${reportData.totalSales}`);
  doc.text(`Toplam Ciro: ${reportData.totalRevenue}₺`);
  doc.moveDown();

  // 3.4. En Çok Satan Ürünler Tablosu
  doc.fontSize(16).text('EN ÇOK SATAN ÜRÜNLER:');
  const sortedProducts = Object.entries(reportData.popularProducts).sort(
    (a, b) => b[1] - a[1]
  );

  doc.moveDown();
  doc.fontSize(12);
  doc.text('Ürün Adı', 50, doc.y, { width: 300, align: 'left' });
  doc.text('Adet', 350, doc.y, { width: 100, align: 'right' });
  doc.moveDown();

  sortedProducts.forEach(([product, qty]) => {
    doc.text(product, 50, doc.y, { width: 300, align: 'left' });
    doc.text(qty.toString(), 350, doc.y, { width: 100, align: 'right' });
    doc.moveDown();
  });

  // 3.5. PDF'i tamamla ve dosyaya yaz
  doc.end();

  // 4. PDF'i Firebase Storage'a Yükle
  await new Promise((resolve) => {
    writeStream.on('finish', resolve);
  });

  const bucket = admin.storage().bucket();
  const destination = `reports/${selectedDate}_report.pdf`;
  await bucket.upload(tempFilePath, { destination });

  // 5. İndirme Linki Oluştur
  const file = bucket.file(destination);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: '03-09-2491', // Uzun süreli link
  });

  return { url }; // Kullanıcıya bu linki gönder
});