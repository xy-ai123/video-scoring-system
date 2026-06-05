-- CreateTable
CREATE TABLE "Phone" (
    "internal" TEXT NOT NULL,
    "modelNumber" TEXT NOT NULL,
    "phoneSerial" TEXT,
    "imei" TEXT,
    "imei2" TEXT,
    "rentedOut" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Phone_pkey" PRIMARY KEY ("internal")
);
