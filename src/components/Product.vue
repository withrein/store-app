<template>
    <div class="px-5">
      <h2 class="text-xl font-bold mb-4">Product List</h2>
    </div>
  
    <div class="px-5">
      <!-- Grid with 5 columns -->
      <div class="grid grid-cols-5 gap-10">
        <div
          v-for="product in paginatedProducts[currentPage]"
          :key="product.id"
          class="border p-2 rounded shadow"
        >
          <img :src="product.imageUrl" alt="product image" class="w-full h-auto mb-2" />
          <div class="font-semibold">{{ product.title }}</div>
          <div class="text-gray-600">{{ product.price }}₮</div>
        </div>
      </div>
    </div>
  
    <!-- Pagination buttons -->
    <div class="mt-4 flex gap-2 px-5 justify-center items-center mb-10">
      <button
        v-for="(chunk, index) in paginatedProducts"
        :key="index"
        @click="currentPage = index"
        class="px-3 py-1 border rounded"
        :class="{ 'bg-black text-white': currentPage === index }"
      >
        {{ index + 1 }}
      </button>
    </div>
  </template>
  
  <script setup>
  import { ref, computed } from 'vue'
  import productsData from '../data/products.json'
  
  const currentPage = ref(0)
  
  // Chunk the data into groups of 5
  const paginatedProducts = computed(() => {
    const chunkSize = 20
    const result = []
    for (let i = 0; i < productsData.length; i += chunkSize) {
      result.push(productsData.slice(i, i + chunkSize))
    }
    return result
  })
  </script>
  
  <style scoped>
  /* Add any styles you want here */
  </style>
  